import { Router, type Request, type Response } from "express";
import { CallRequest, CONTACT_TYPES } from "../db/models/CallRequest.js";
import { RawCapture } from "../db/models/RawCapture.js";
import { createOutboundCall } from "../vapi/calls.js";
import { buildCallVariables } from "./callVariables.js";
import type { CallRequestPayload } from "../mdr/types.js";

export const mdrCallRequestRouter = Router();

// Structural analogue of the reference project's mdrWebhook.ts, same
// raw-capture-first/gated/upsert shape, opposite data direction: MDR is
// pushing us a new call request instead of a status update.
// Registered at the bottom of this file through a try/catch wrapper —
// Express 4 does NOT forward a rejected async handler to the error
// middleware, so before this any unexpected error (e.g. a Mongoose
// validation failure on contact.type) left the request with no response at
// all, and MDR just saw a timeout (confirmed 2026-10-06 with MDR's
// "CARRIER" / "CARRIER REPRESENTATIVE" payloads).
async function handleCallRequest(req: Request, res: Response): Promise<void> {
  if (req.header("x-api-key") !== process.env.MDR_WEBHOOK_SHARED_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const startedAt = performance.now();

  // Raw-capture first, unconditionally, before any parsing — a crash here
  // must not take the request (or the process) down. The write is STARTED
  // first but not awaited until just before we respond, so it overlaps with
  // the CallRequest write and the Vapi call instead of adding its own
  // round trip to MDR's wait. Never rejects (errors are logged and
  // swallowed), and every response path below awaits it, so the audit
  // guarantee is the same as before — it's just no longer serialized.
  const rawCaptured = RawCapture.create({ source: "mdr_call_request", payload: req.body }).then(
    () => undefined,
    (err: unknown) => console.error("[mdrCallRequest] raw capture failed", err),
  );

  const body = req.body as Partial<CallRequestPayload>;
  if (
    !body?.mdr_call_id ||
    !body.call_type ||
    !body.contact ||
    !Array.isArray(body.shipments) ||
    body.shipments.length === 0
  ) {
    await rawCaptured;
    res.status(400).json({
      error: "missing required fields: mdr_call_id, call_type, contact, shipments (non-empty array)",
    });
    return;
  }

  // Reject a bad contact up front with a message MDR can act on, instead of
  // letting the database write fail. contact.type must be one of the
  // accepted values EXACTLY (e.g. "CARRIER_REPRESENTATIVE", underscore, not
  // "CARRIER REPRESENTATIVE" or "CARRIER").
  const contactProblems: string[] = [];
  const contact = body.contact as Partial<{ type: unknown; name: unknown; phone: unknown }>;
  if (!(CONTACT_TYPES as readonly unknown[]).includes(contact.type)) {
    contactProblems.push(`contact.type ${JSON.stringify(contact.type)} is not an accepted value`);
  }
  if (typeof contact.name !== "string" || !contact.name.trim()) {
    contactProblems.push("contact.name is required");
  }
  if (typeof contact.phone !== "string" || !contact.phone.trim()) {
    contactProblems.push("contact.phone is required");
  }
  if (contactProblems.length > 0) {
    await rawCaptured;
    res.status(400).json({
      error: "invalid contact",
      details: contactProblems,
      allowed_contact_types: CONTACT_TYPES,
    });
    return;
  }

  let callRequestDoc;
  try {
    callRequestDoc = await CallRequest.create({
      mdr_call_id: body.mdr_call_id,
      // Stored/echoed only — never validated or branched on, see
      // mdr/types.ts's CallRequestPayload.call_type comment.
      call_type: body.call_type,
      contact: body.contact,
      calling_from: typeof body.calling_from === "string" && body.calling_from.trim() ? body.calling_from.trim() : null,
      shipments: body.shipments,
    });
  } catch (err: unknown) {
    // Duplicate mdr_call_id = MDR retried a request we already accepted.
    // Not an error — return the existing record's status.
    if (isDuplicateKeyError(err)) {
      const existing = await CallRequest.findOne({ mdr_call_id: body.mdr_call_id });
      await rawCaptured;
      res.status(202).json({
        success: true,
        mdr_call_id: body.mdr_call_id,
        voice_call_id: existing?.vapi_call_id ?? null,
        status: "QUEUED",
      });
      return;
    }
    throw err;
  }

  const dbCreatedAt = performance.now();
  try {
    const variableValues = buildCallVariables(callRequestDoc);
    const call = await createOutboundCall({
      phoneNumberId: requireEnv("VAPI_PHONE_NUMBER_ID"),
      assistantId: requireEnv("VAPI_ASSISTANT_ID"),
      customerNumber: callRequestDoc.contact.phone,
      variableValues,
    });

    const vapiDoneAt = performance.now();
    callRequestDoc.vapi_call_id = call.id;
    callRequestDoc.control_url = call.monitor?.controlUrl ?? null;
    callRequestDoc.lifecycle_status = "CALLING";
    await callRequestDoc.save();
    await rawCaptured;

    // Per-step timing, one line per request, so a slow response can be
    // pinned on a specific step (our DB vs. Vapi) from the server log
    // instead of guessed at.
    const doneAt = performance.now();
    console.log(
      `[mdrCallRequest] ${callRequestDoc.mdr_call_id} timings ms: db_create=${Math.round(dbCreatedAt - startedAt)} vapi_create_call=${Math.round(vapiDoneAt - dbCreatedAt)} db_save=${Math.round(doneAt - vapiDoneAt)} total=${Math.round(doneAt - startedAt)}`,
    );

    // Shape confirmed by MDR (integration guide §4) — MDR saves all three
    // fields, plus `success`.
    res.status(202).json({
      success: true,
      mdr_call_id: callRequestDoc.mdr_call_id,
      voice_call_id: call.id,
      status: "QUEUED",
    });
  } catch (err) {
    console.error(`[mdrCallRequest] failed to place call for ${body.mdr_call_id}`, err);
    callRequestDoc.lifecycle_status = "FAILED";
    await callRequestDoc.save();
    res.status(502).json({ error: "failed to place outbound call" });
  }
}

mdrCallRequestRouter.post("/call-requests", async (req, res) => {
  try {
    await handleCallRequest(req, res);
  } catch (err) {
    console.error("[mdrCallRequest] unhandled error", err);
    if (!res.headersSent) {
      // A schema validation failure that slipped past the checks above is
      // still the caller's bad input, not a server fault.
      if (isValidationError(err)) {
        res.status(400).json({ error: "validation failed", details: (err as Error).message });
      } else {
        res.status(500).json({ error: "internal error" });
      }
    }
  }
});

function isValidationError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ValidationError";
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
