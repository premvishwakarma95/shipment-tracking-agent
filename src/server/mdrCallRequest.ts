import { Router } from "express";
import { CallRequest } from "../db/models/CallRequest.js";
import { RawCapture } from "../db/models/RawCapture.js";
import { createOutboundCall } from "../vapi/calls.js";
import { buildCallVariables } from "./callVariables.js";
import type { CallRequestPayload } from "../mdr/types.js";

export const mdrCallRequestRouter = Router();

// Structural analogue of the reference project's mdrWebhook.ts, same
// raw-capture-first/gated/upsert shape, opposite data direction: MDR is
// pushing us a new call request instead of a status update.
mdrCallRequestRouter.post("/call-requests", async (req, res) => {
  if (req.header("x-api-key") !== process.env.MDR_WEBHOOK_SHARED_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Raw-capture first, unconditionally, before any parsing — a crash here
  // must not take the request (or the process) down.
  try {
    await RawCapture.create({ source: "mdr_call_request", payload: req.body });
  } catch (err) {
    console.error("[mdrCallRequest] raw capture failed", err);
  }

  const body = req.body as Partial<CallRequestPayload>;
  if (!body?.mdr_call_id || !body.call_type || !body.contact || !body.shipment) {
    res.status(400).json({
      error: "missing required fields: mdr_call_id, call_type, contact, shipment",
    });
    return;
  }

  let callRequestDoc;
  try {
    callRequestDoc = await CallRequest.create({
      mdr_call_id: body.mdr_call_id,
      call_type: body.call_type,
      contact: body.contact,
      shipment: body.shipment,
      previous_interactions: body.previous_interactions ?? [],
      open_items: body.open_items ?? [],
    });
  } catch (err: unknown) {
    // Duplicate mdr_call_id = MDR retried a request we already accepted.
    // Not an error — return the existing record's status.
    if (isDuplicateKeyError(err)) {
      const existing = await CallRequest.findOne({ mdr_call_id: body.mdr_call_id });
      res.status(202).json({
        mdr_call_id: body.mdr_call_id,
        voice_call_id: existing?.vapi_call_id ?? null,
        status: "already_accepted",
      });
      return;
    }
    throw err;
  }

  try {
    const variableValues = buildCallVariables(callRequestDoc);
    const call = await createOutboundCall({
      phoneNumberId: requireEnv("VAPI_PHONE_NUMBER_ID"),
      assistantId: requireEnv("VAPI_ASSISTANT_ID"),
      customerNumber: callRequestDoc.contact.phone,
      variableValues,
    });

    callRequestDoc.vapi_call_id = call.id;
    callRequestDoc.lifecycle_status = "CALLING";
    await callRequestDoc.save();

    res.status(202).json({
      mdr_call_id: callRequestDoc.mdr_call_id,
      voice_call_id: call.id,
      status: "accepted",
    });
  } catch (err) {
    console.error(`[mdrCallRequest] failed to place call for ${body.mdr_call_id}`, err);
    callRequestDoc.lifecycle_status = "FAILED";
    await callRequestDoc.save();
    res.status(502).json({ error: "failed to place outbound call" });
  }
});

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
