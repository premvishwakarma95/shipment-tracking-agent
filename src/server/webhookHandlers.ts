import { CallRequest, type CallRequestDoc } from "../db/models/CallRequest.js";
import { classifyEventType } from "./callOutcome.js";
import { normalizeMdrTimestamp } from "./timeFormat.js";
import { normalizePhoneE164 } from "./phoneFormat.js";
import { computeEta } from "./etaCalc.js";
import { sendVoiceWebhookEvent } from "../mdr/api.js";
import { sayAndEndCall } from "../vapi/callControl.js";
import { getCall } from "../vapi/calls.js";
import { WRONG_NUMBER_MESSAGE } from "../assistant/prompt.js";
import type {
  CommonCallResult,
  ContactInfo,
  PartialShipmentResult,
  ShipmentResult,
  VoiceWebhookEvent,
} from "../mdr/types.js";

// Vapi's inbound webhook message shapes are permissive/`any`-typed here —
// this is an external contract we don't control the exact fields of, and
// RawCapture (see mdrCallRequest.ts's inbound equivalent, wired in
// index.ts) holds the raw payload if anything here needs to be fixed up
// later.

interface VapiToolCall {
  id: string;
  function: { name: string; arguments: Record<string, unknown> };
}

// Resolves by Vapi's own call ID, never by anything the LLM supplied
// mid-conversation — same hard rule as the reference project.
async function resolveByVapiCallId(vapiCallId: string): Promise<CallRequestDoc & { save: () => Promise<unknown> } | null> {
  return CallRequest.findOne({ vapi_call_id: vapiCallId }) as unknown as
    | (CallRequestDoc & { save: () => Promise<unknown> })
    | null;
}

export async function handleToolCalls(message: {
  call: { id: string };
  toolCallList: VapiToolCall[];
}) {
  const doc = await resolveByVapiCallId(message.call.id);
  if (!doc) {
    console.error(`[webhookHandlers] no CallRequest for vapi call ${message.call.id}`);
    return { results: [] };
  }

  const results: Array<{ toolCallId: string; result: string }> = [];

  for (const call of message.toolCallList ?? []) {
    try {
      await applyToolCall(doc, call);
      results.push({ toolCallId: call.id, result: "ok" });
    } catch (err) {
      // One bad tool call must not kill the rest of the batch.
      console.error(`[webhookHandlers] tool call ${call.function.name} failed`, err);
      results.push({ toolCallId: call.id, result: "error" });
    }
  }

  await doc.save();
  return { results };
}

async function applyToolCall(doc: CallRequestDoc, call: VapiToolCall) {
  const args = call.function.arguments ?? {};

  switch (call.function.name) {
    case "reportWrongContact": {
      const referredName = (args.referred_name as string) ?? null;
      const referredPhone = (args.referred_phone as string) ?? null;
      doc.tool_flags.wrong_contact = true;
      doc.tool_flags.referred_contact = { name: referredName, phone: referredPhone };

      // No referral given = the wrong-number case (see prompt.ts's
      // Introduction section): the LLM says nothing itself, so OUR server
      // speaks MDR's exact closing line and ends the call deterministically
      // via Live Call Control, rather than relying on the model to say a
      // custom line and then somehow hang up — see callControl.ts for why.
      if (!referredName && !referredPhone && doc.control_url) {
        await sayAndEndCall(doc.control_url, WRONG_NUMBER_MESSAGE);
      }
      return;
    }
    case "reportCallbackRequested":
      doc.tool_flags.callback_requested = true;
      doc.tool_flags.callback_after_minutes = (args.callback_after_minutes as number) ?? null;
      return;
    case "reportEmailRequested":
      // No confirmed MDR event_type for this yet — kept for internal
      // visibility only, see docs/requirements-tracker.md.
      doc.tool_flags.email_requested = true;
      doc.tool_flags.requested_email = (args.requested_email as string) ?? null;
      return;
    case "flagHumanEscalation":
      // Call-level only — see mdr/types.ts's CommonCallResult.
      // human_escalation_required comment for why this isn't merged into
      // any individual shipment's result.
      doc.tool_flags.human_escalation_required = true;
      doc.tool_flags.escalation_reason = (args.escalation_reason as string) ?? null;
      return;
    default:
      throw new Error(`unknown tool: ${call.function.name}`);
  }
}

export async function handleEndOfCallReport(message: {
  call: { id: string };
  endedReason?: string;
  recordingUrl?: string;
  transcript?: string;
  startedAt?: string;
  endedAt?: string;
  analysis?: { structuredData?: Record<string, unknown> };
}) {
  const doc = await resolveByVapiCallId(message.call.id);
  if (!doc) {
    console.error(`[webhookHandlers] no CallRequest for vapi call ${message.call.id}`);
    return;
  }

  let structured = message.analysis?.structuredData ?? {};
  // RETRY FALLBACK, added 2026-09-29 — real test calls showed
  // analysis.structuredData sometimes entirely absent from this webhook
  // even when the conversation was clean and complete, while a follow-up
  // GET /call/{id} moments later HAD it. Root-caused as a race: Vapi's
  // own docs say structured-data analysis "typically completes within a
  // few seconds" after the call ends, but end-of-call-report fires
  // immediately at call end — sometimes before that analysis pass
  // finishes. Investigated migrating to Vapi's newer Structured Outputs
  // API instead (their docs recommend it over analysisPlan for
  // reliability) but its own docs are contradictory about persistence/
  // webhook delivery (one page says results are stored and retrievable,
  // another says "NOT stored... webhook access only") — too big a risk to
  // build on blind. This polls the same GET /call/{id} endpoint already
  // used reliably elsewhere in this codebase instead.
  if (!hasStructuredShipments(structured)) {
    const recovered = await pollForStructuredData(message.call.id);
    if (recovered) structured = recovered;
  }
  const eventType = classifyEventType(
    message.endedReason,
    doc.tool_flags,
    structured.call_ended_abruptly as boolean | undefined,
    message.transcript,
  );

  // Split 2026-09-29 per the user's direction — structured_result stores
  // just the shipments array directly (not wrapped in the raw
  // { shipments, call_ended_abruptly } object), and call_ended_abruptly
  // is its own top-level field. FURTHER CHANGED 2026-09-29: built via
  // buildShipmentResults (the same function used for the actual MDR
  // payload) rather than the raw Vapi extraction — MDR requires the
  // nested driver/dispatcher: {name, phone, email} shape (matching
  // production's original format), but resultSchema.ts's extraction
  // schema deliberately stays FLAT (driver_name/driver_phone/...) for
  // extraction reliability (see that file's header comment — nested
  // objects were a real cause of dropped/failed extractions earlier
  // today). This keeps that fix intact while still storing the nested
  // shape internally, by reshaping at storage time instead of reverting
  // the schema. Each entry's `result` fields are spread directly onto the
  // shipment object (no `result` wrapper) — that wrapper is specific to
  // the outbound MDR contract (VoiceWebhookEvent's ShipmentResult), not
  // wanted in this internal debug copy.
  doc.started_at = message.startedAt ? new Date(message.startedAt) : null;
  doc.ended_at = message.endedAt ? new Date(message.endedAt) : null;
  doc.structured_result = buildShipmentResults(doc, structured).map(({ shipment_id, status, result }) => ({
    shipment_id,
    status,
    ...result,
  }));
  doc.call_ended_abruptly = (structured.call_ended_abruptly as boolean) ?? null;
  doc.event_type = eventType;
  doc.recording_url = message.recordingUrl ?? null;
  doc.transcript = message.transcript ?? null;
  doc.lifecycle_status = "COMPLETED";

  const event = buildWebhookEvent(doc, structured, eventType);
  await doc.save();

  // Idempotency guard: if a retried end-of-call-report webhook arrives
  // (Vapi retries on non-2xx), don't push to MDR twice.
  if (doc.mdr_pushed_at) return;

  const pushed = await sendVoiceWebhookEvent(event);
  if (pushed) {
    doc.mdr_pushed_at = new Date();
    await doc.save();
  }
  // On failure, mdr_pushed_at stays null — left for manual reconciliation,
  // see docs/requirements-tracker.md. No retry queue in v1.
}

// True only if `shipments` is present AND non-empty — an empty/missing
// object (Vapi's failure signature, see handleEndOfCallReport) doesn't
// count, but neither does a technically-non-empty object missing the one
// field that actually matters downstream.
function hasStructuredShipments(structured: Record<string, unknown>): boolean {
  return Array.isArray(structured.shipments) && structured.shipments.length > 0;
}

const POLL_MAX_ATTEMPTS = 4;
const POLL_DELAY_MS = 3000;

async function pollForStructuredData(vapiCallId: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
    try {
      const call = await getCall(vapiCallId);
      const structured = call.analysis?.structuredData;
      if (structured && hasStructuredShipments(structured)) {
        console.log(
          `[webhookHandlers] recovered structuredData via poll (attempt ${attempt}/${POLL_MAX_ATTEMPTS}) for call ${vapiCallId}`,
        );
        return structured;
      }
    } catch (err) {
      console.warn(`[webhookHandlers] poll attempt ${attempt}/${POLL_MAX_ATTEMPTS} for call ${vapiCallId} failed`, err);
    }
  }
  console.warn(
    `[webhookHandlers] structuredData still missing after ${POLL_MAX_ATTEMPTS} poll attempts for call ${vapiCallId} — giving up`,
  );
  return null;
}

interface ShipmentRecord {
  shipment_id?: unknown;
  status?: unknown;
  estimated_delivery_date?: unknown;
  delivery_appointment?: unknown;
  [key: string]: unknown;
}

const NOT_REACHED_SUMMARY = "Not discussed on this call.";

// One entry per shipment MDR sent on the inbound request (doc.shipments is
// the source of truth for WHICH shipments to report — not the extraction
// output, so a shipment the call never reached still gets an entry rather
// than silently vanishing from the response). Each entry's data comes from
// the matching item in the post-call structured extraction's `shipments[]`
// array (see resultSchema.ts), matched by shipment_id.
function buildShipmentResults(
  doc: CallRequestDoc,
  structured: Record<string, unknown>,
): ShipmentResult[] {
  const inboundShipments = (doc.shipments ?? []) as ShipmentRecord[];
  const extractedRaw = structured.shipments;
  const extracted = Array.isArray(extractedRaw) ? (extractedRaw as Record<string, unknown>[]) : [];
  const byId = new Map(extracted.map((s) => [String(s.shipment_id ?? ""), s]));

  // Reference "now" for ETA arithmetic: when the call actually started
  // (started_at is set from Vapi's report before this runs), else when we
  // created the request.
  const callTime =
    doc.started_at ?? (doc as unknown as { createdAt?: Date }).createdAt ?? new Date();

  return inboundShipments.map((shipment, index) => {
    const shipmentId =
      typeof shipment.shipment_id === "string" && shipment.shipment_id
        ? shipment.shipment_id
        : `unknown-${index + 1}`;
    // Single-shipment calls don't speak the shipment ID aloud (see
    // callVariables.ts's shipmentWordingRule), so the extraction pass has
    // no ID to attribute its entry to and returns shipment_id empty — with
    // exactly one inbound shipment and one extracted entry there's nothing
    // to disambiguate, so pair them directly instead of reporting the
    // shipment as "not reached" (confirmed 2026-10-06, LOCAL-DRIVER-001).
    const match =
      byId.get(shipmentId) ??
      (inboundShipments.length === 1 && extracted.length === 1 ? extracted[0] : undefined);
    if (!match) {
      console.warn(
        `[webhookHandlers] no extraction result for shipment ${shipmentId} on call ${doc.vapi_call_id} — likely not reached before the call ended`,
      );
    }
    return {
      shipment_id: shipmentId,
      status: typeof shipment.status === "string" ? shipment.status : null,
      result: buildCommonResult(match ?? {}, doc.tool_flags, !match, shipment, callTime),
    };
  });
}

// Builds one shipment's CommonCallResult from its slice of the post-call
// structured extraction. `notReached` is true when the call ended before
// this shipment came up at all (no matching extraction entry) — reported
// as an all-null result with an explanatory call_summary rather than a
// fabricated one.
function buildCommonResult(
  structured: Record<string, unknown>,
  toolFlags: CallRequestDoc["tool_flags"],
  notReached: boolean,
  inboundShipment: ShipmentRecord,
  callTime: Date,
): CommonCallResult {
  return {
    driver_confirmed: (structured.driver_confirmed as boolean) ?? null,
    driver_assigned: (structured.driver_assigned as boolean) ?? null,
    equipment_assigned: (structured.equipment_assigned as boolean) ?? null,
    pickup_completed: (structured.pickup_completed as boolean) ?? null,
    pickup_completed_at: normalizeMdrTimestamp(structured.pickup_completed_at, "pickup_completed_at"),
    delivery_completed: (structured.delivery_completed as boolean) ?? null,
    delivery_completed_at: normalizeMdrTimestamp(structured.delivery_completed_at, "delivery_completed_at"),
    scheduled_pickup_date_correct: (structured.scheduled_pickup_date_correct as boolean) ?? null,

    current_location: (structured.current_location as string) ?? null,
    // Computed in code from what the caller said (eta_kind + numbers) and
    // the shipment's own schedule — see etaCalc.ts.
    eta: computeEta(structured, inboundShipment, callTime),

    delay: (structured.delay as boolean) ?? null,
    delay_minutes: (structured.delay_minutes as number) ?? null,
    delay_reason: (structured.delay_reason as string) ?? null,
    issue_type: (structured.issue_type as string) ?? null,

    appointment_status:
      (structured.appointment_status as CommonCallResult["appointment_status"]) ?? null,

    // Per-shipment escalation comes ONLY from the extraction pass now —
    // deliberately NOT OR'd with toolFlags.human_escalation_required the
    // way the old single-shipment code combined the two signals. The
    // flagHumanEscalation tool is call-level (tools.ts's hard "never
    // accept an LLM-supplied ID" rule means it can't say WHICH shipment),
    // so merging it into every shipment's result here would falsely mark
    // every shipment on the call as escalated when only one actually had
    // an issue. Confirmed empirically (2026-09-28 multi-shipment
    // extraction test) that the extraction pass alone reliably attributes
    // fields to the correct shipment — revisit this if that stops holding
    // up on real multi-shipment calls. toolFlags.human_escalation_required
    // is still recorded on CallRequest for internal visibility/audit.
    human_escalation_required: Boolean(structured.human_escalation_required),
    escalation_reason: (structured.escalation_reason as string) ?? null,

    // Defensive fallback only — resultSchema.ts's `required` list and
    // extraction prompt should already force these two to always be
    // present for a shipment that WAS reached. If still missing (and the
    // shipment was reached), that's the extraction pass misbehaving, not a
    // real "unconfirmed" case, so warn loudly rather than silently sending
    // MDR a fabricated-looking default.
    confidence_score: notReached
      ? 0
      : valueOrWarnDefault(structured.confidence_score as number | undefined, 0, "confidence_score"),
    call_summary: notReached
      ? NOT_REACHED_SUMMARY
      : valueOrWarnDefault(structured.call_summary as string | undefined, "No summary available.", "call_summary"),
    next_action: (structured.next_action as string) ?? null,
    open_issue: (structured.open_issue as string) ?? null,

    // FLATTENED 2026-09-28 — resultSchema.ts now extracts flat
    // driver_name/driver_phone/driver_email fields (not a nested driver
    // object) to improve extraction reliability; reconstructed into the
    // nested ContactInfo shape here since that's the unchanged, confirmed
    // outbound contract to MDR. See resultSchema.ts's file header comment.
    driver: contactInfoFromFlatFields(structured.driver_name, structured.driver_phone, structured.driver_email),
    dispatcher: contactInfoFromFlatFields(
      structured.dispatcher_name,
      structured.dispatcher_phone,
      structured.dispatcher_email,
    ),
    contacts_confirmed: (structured.contacts_confirmed as boolean) ?? null,
  };
}

// Deliberately simple/permissive (RFC 5322 has far more valid shapes than
// this) — the point isn't strict validation, it's a deterministic backstop
// against the LLM extraction confidently returning obvious garbage (e.g.
// "pests at error", confirmed empirically 2026-09-24, TEST-CONTACT-
// UPDATE-003 — that specific case was already correctly left null by the
// extraction, but this exists so a similarly garbled value NEVER reaches
// MDR even if the extraction's judgment is wrong some other time).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reconstructs a nested ContactInfo from resultSchema.ts's flat
// driver_*/dispatcher_* extraction fields — null (not an all-null object)
// when nothing at all was captured, same semantics the old nested-object
// version had.
function contactInfoFromFlatFields(name: unknown, phone: unknown, email: unknown): ContactInfo | null {
  const n = typeof name === "string" && name ? name : null;
  // Country code always included (+1 default) — see phoneFormat.ts.
  const rawPhone = typeof phone === "string" && phone ? phone : null;
  let p = normalizePhoneE164(rawPhone);
  if (rawPhone && !p) {
    // The caller did give a number, it just isn't a valid E.164 one (e.g.
    // too short) — keep the digits as heard rather than losing it; MDR
    // can see it and the agent already read it back to the caller.
    const digitsOnly = rawPhone.replace(/\D/g, "");
    console.warn(`[webhookHandlers] extraction returned non-standard phone "${rawPhone}" — keeping digits "${digitsOnly}"`);
    p = digitsOnly || null;
  }
  let e = typeof email === "string" && email ? email : null;
  if (e && !EMAIL_PATTERN.test(e)) {
    console.warn(`[webhookHandlers] extraction returned malformed email "${e}" — dropping to null`);
    e = null;
  }
  if (!n && !p && !e) return null;
  return { name: n, phone: p, email: e };
}

function valueOrWarnDefault<T>(value: T | undefined | null, fallback: T, field: string): T {
  if (value === undefined || value === null) {
    console.warn(`[webhookHandlers] structured extraction omitted required field "${field}" — using fallback`);
    return fallback;
  }
  return value;
}

// Whole-call summary for CALL_DROPPED/CALL_HANG — joins whichever
// shipments actually got discussed. ASSUMPTION, not confirmed by MDR: the
// old single-shipment code had one natural call_summary; there's no worked
// multi-shipment example for a dropped/hung call yet. Flag in
// docs/requirements-tracker.md; revisit once MDR gives a real example.
function summarizePartialShipments(shipments: PartialShipmentResult[]): string | null {
  const summaries = shipments
    .map((s) => s.result.call_summary)
    .filter((summary): summary is string => Boolean(summary) && summary !== NOT_REACHED_SUMMARY);
  return summaries.length > 0 ? summaries.join(" ") : null;
}

function buildWebhookEvent(
  doc: CallRequestDoc,
  structured: Record<string, unknown>,
  eventType: VoiceWebhookEvent["event_type"],
): VoiceWebhookEvent {
  const voiceCallId = doc.vapi_call_id ?? null;

  switch (eventType) {
    case "NO_ANSWER":
    case "VOICEMAIL":
    case "BUSY":
    case "CALL_FAILED":
      return { event_type: eventType, mdr_call_id: doc.mdr_call_id, voice_call_id: voiceCallId };

    // Identical construction, only event_type differs — see CallRequest.ts's
    // EVENT_TYPES comment for what distinguishes the two (classifyEventType
    // in callOutcome.ts is where that distinction is actually decided).
    case "CALL_DROPPED":
    case "CALL_HANG": {
      const shipments = buildShipmentResults(doc, structured) as PartialShipmentResult[];
      return {
        event_type: eventType,
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        shipments,
        call_summary: summarizePartialShipments(shipments),
      };
    }

    case "CALLBACK_REQUESTED":
      return {
        event_type: "CALLBACK_REQUESTED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        callback_after_minutes: doc.tool_flags.callback_after_minutes ?? null,
        call_summary: (structured.call_summary as string) ?? null,
      };

    case "WRONG_CONTACT":
      return {
        event_type: "WRONG_CONTACT",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        referred_contact: {
          name: doc.tool_flags.referred_contact?.name ?? null,
          phone: doc.tool_flags.referred_contact?.phone ?? null,
        },
      };

    case "CALL_COMPLETED":
      return {
        event_type: "CALL_COMPLETED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        call_type: doc.call_type,
        call_status: "COMPLETED",
        shipments: buildShipmentResults(doc, structured),
        recording_url: doc.recording_url ?? null,
        transcript: doc.transcript ?? null,
      };
  }
}
