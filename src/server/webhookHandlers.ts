import { CallRequest, type CallRequestDoc } from "../db/models/CallRequest.js";
import { classifyEventType } from "./callOutcome.js";
import { sendVoiceWebhookEvent } from "../mdr/api.js";
import { sayAndEndCall } from "../vapi/callControl.js";
import { WRONG_NUMBER_MESSAGE } from "../assistant/prompt.js";
import type { CommonCallResult, ContactInfo, ContactUpdateResult, VoiceWebhookEvent } from "../mdr/types.js";

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

  const structured = message.analysis?.structuredData ?? {};
  const eventType = classifyEventType(
    message.endedReason,
    doc.tool_flags,
    structured.call_ended_abruptly as boolean | undefined,
    message.transcript,
  );

  doc.structured_result = structured;
  doc.event_type = eventType;
  doc.recording_url = message.recordingUrl ?? null;
  doc.transcript = message.transcript ?? null;
  doc.started_at = message.startedAt ? new Date(message.startedAt) : null;
  doc.ended_at = message.endedAt ? new Date(message.endedAt) : null;
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

// Builds a common result (used for both CALL_COMPLETED.result and
// CALL_DROPPED.partial_result) from the post-call structured extraction,
// cross-checked against tool_flags for escalation (see
// src/assistant/resultSchema.ts for why both signals are combined).
function buildCommonResult(
  structured: Record<string, unknown>,
  toolFlags: CallRequestDoc["tool_flags"],
): CommonCallResult {
  return {
    driver_confirmed: (structured.driver_confirmed as boolean) ?? null,
    driver_assigned: (structured.driver_assigned as boolean) ?? null,
    equipment_assigned: (structured.equipment_assigned as boolean) ?? null,
    pickup_completed: (structured.pickup_completed as boolean) ?? null,
    pickup_completed_at: (structured.pickup_completed_at as string) ?? null,
    delivery_completed: (structured.delivery_completed as boolean) ?? null,

    current_location: (structured.current_location as string) ?? null,
    eta: (structured.eta as string) ?? null,

    delay: (structured.delay as boolean) ?? null,
    delay_minutes: (structured.delay_minutes as number) ?? null,
    delay_reason: (structured.delay_reason as string) ?? null,
    issue_type: (structured.issue_type as string) ?? null,

    appointment_status:
      (structured.appointment_status as CommonCallResult["appointment_status"]) ?? null,

    // Both signals combined: the in-call tool (immediate, LLM-decided) and
    // the post-call extraction (a backstop in case the tool wasn't called
    // but the transcript shows an escalation-worthy issue on review).
    human_escalation_required:
      Boolean(toolFlags?.human_escalation_required) ||
      Boolean(structured.human_escalation_required),
    escalation_reason:
      (toolFlags?.escalation_reason as string) ?? (structured.escalation_reason as string) ?? null,

    // Defensive fallback only — resultSchema.ts's `required` list and
    // extraction prompt should already force these two to always be
    // present. If they're still missing, that's the extraction pass
    // misbehaving, not a real "unconfirmed" case, so warn loudly rather
    // than silently sending MDR a fabricated-looking default.
    confidence_score: valueOrWarnDefault(
      structured.confidence_score as number | undefined,
      0,
      "confidence_score",
    ),
    call_summary: valueOrWarnDefault(
      structured.call_summary as string | undefined,
      "No summary available.",
      "call_summary",
    ),
    next_action: (structured.next_action as string) ?? null,
    open_issue: (structured.open_issue as string) ?? null,
  };
}

// Builds ContactUpdateResult — the separate result shape used ONLY for
// CONTACT_UPDATE_REQUEST calls (see mdr/types.ts, contactUpdateResultSchema.ts).
// Deliberately NOT a case in buildCommonResult — this call type's structured
// extraction is a different schema entirely, not a superset/subset of
// CommonCallResult's fields.
function buildContactUpdateResult(
  structured: Record<string, unknown>,
  toolFlags: CallRequestDoc["tool_flags"],
): ContactUpdateResult {
  return {
    driver: toContactInfo(structured.driver),
    dispatcher: toContactInfo(structured.dispatcher),
    contacts_confirmed: (structured.contacts_confirmed as boolean) ?? null,

    confidence_score: valueOrWarnDefault(
      structured.confidence_score as number | undefined,
      0,
      "confidence_score",
    ),
    call_summary: valueOrWarnDefault(
      structured.call_summary as string | undefined,
      "No summary available.",
      "call_summary",
    ),

    // Same pattern as buildCommonResult — flagHumanEscalation is a generic
    // tool, available (and equally meaningful) on every call type.
    human_escalation_required:
      Boolean(toolFlags?.human_escalation_required) ||
      Boolean(structured.human_escalation_required),
    escalation_reason:
      (toolFlags?.escalation_reason as string) ?? (structured.escalation_reason as string) ?? null,
    next_action: (structured.next_action as string) ?? null,
    open_issue: (structured.open_issue as string) ?? null,
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

function toContactInfo(value: unknown): ContactInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const email = (v.email as string) ?? null;
  if (email && !EMAIL_PATTERN.test(email)) {
    console.warn(`[webhookHandlers] extraction returned malformed email "${email}" — dropping to null`);
  }
  return {
    name: (v.name as string) ?? null,
    phone: (v.phone as string) ?? null,
    email: email && EMAIL_PATTERN.test(email) ? email : null,
  };
}

function valueOrWarnDefault<T>(value: T | undefined | null, fallback: T, field: string): T {
  if (value === undefined || value === null) {
    console.warn(`[webhookHandlers] structured extraction omitted required field "${field}" — using fallback`);
    return fallback;
  }
  return value;
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

    case "CALL_DROPPED": {
      const result =
        doc.call_type === "CONTACT_UPDATE_REQUEST"
          ? buildContactUpdateResult(structured, doc.tool_flags)
          : buildCommonResult(structured, doc.tool_flags);
      return {
        event_type: "CALL_DROPPED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        partial_result: result,
        call_summary: result.call_summary,
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
      if (doc.call_type === "CONTACT_UPDATE_REQUEST") {
        return {
          event_type: "CALL_COMPLETED",
          mdr_call_id: doc.mdr_call_id,
          voice_call_id: voiceCallId,
          call_type: "CONTACT_UPDATE_REQUEST",
          call_status: "COMPLETED",
          result: buildContactUpdateResult(structured, doc.tool_flags),
          recording_url: doc.recording_url ?? null,
          transcript: doc.transcript ?? null,
        };
      }
      return {
        event_type: "CALL_COMPLETED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        call_type: doc.call_type,
        call_status: "COMPLETED",
        result: buildCommonResult(structured, doc.tool_flags),
        recording_url: doc.recording_url ?? null,
        transcript: doc.transcript ?? null,
      };
  }
}
