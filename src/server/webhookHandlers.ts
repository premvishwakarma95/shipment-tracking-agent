import { CallRequest, type CallRequestDoc } from "../db/models/CallRequest.js";
import { classifyCallStatus } from "./callOutcome.js";
import { pushCallResult } from "../mdr/api.js";
import type { CallResultPayload } from "../mdr/types.js";

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
      applyToolCall(doc, call);
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

function applyToolCall(doc: CallRequestDoc, call: VapiToolCall) {
  const args = call.function.arguments ?? {};

  switch (call.function.name) {
    case "reportWrongContact":
      doc.tool_flags.wrong_contact = true;
      doc.tool_flags.referred_contact = {
        name: (args.referred_name as string) ?? null,
        phone: (args.referred_phone as string) ?? null,
      };
      return;
    case "reportCallbackRequested":
      doc.tool_flags.callback_requested = true;
      doc.tool_flags.callback_time = (args.callback_time as string) ?? null;
      return;
    case "reportEmailRequested":
      doc.tool_flags.email_requested = true;
      doc.tool_flags.requested_email = (args.requested_email as string) ?? null;
      return;
    case "flagHumanEscalation":
      doc.tool_flags.human_escalation_required = true;
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
  const callStatus = classifyCallStatus(message.endedReason, doc.tool_flags);
  const answered = callStatus !== "NO_ANSWER" && callStatus !== "BUSY";

  doc.structured_result = structured;
  doc.call_status = callStatus;
  doc.recording_url = message.recordingUrl ?? null;
  doc.transcript = message.transcript ?? null;
  doc.started_at = message.startedAt ? new Date(message.startedAt) : null;
  doc.ended_at = message.endedAt ? new Date(message.endedAt) : null;
  doc.lifecycle_status = "COMPLETED";

  const payload = assembleResultPayload(doc, structured, callStatus, answered);
  await doc.save();

  // Idempotency guard: if a retried end-of-call-report webhook arrives
  // (Vapi retries on non-2xx), don't push to MDR twice.
  if (doc.mdr_pushed_at) return;

  const pushed = await pushCallResult(payload);
  if (pushed) {
    doc.mdr_pushed_at = new Date();
    await doc.save();
  }
  // On failure, mdr_pushed_at stays null — left for manual reconciliation,
  // see docs/requirements-tracker.md. No retry queue in v1.
}

function assembleResultPayload(
  doc: CallRequestDoc,
  structured: Record<string, unknown>,
  callStatus: CallResultPayload["call_status"],
  answered: boolean,
): CallResultPayload {
  const shipment = doc.shipment as Record<string, unknown>;
  const previousEta = (shipment?.current_eta as string) ?? null;
  const eta = (structured.eta as string) ?? null;

  return {
    mdr_call_id: doc.mdr_call_id,
    voice_call_id: doc.vapi_call_id ?? "",
    call_type: doc.call_type,
    call_status: callStatus,
    answered,
    contact: doc.contact,
    result: {
      driver_confirmed: (structured.driver_confirmed as boolean) ?? null,
      driver_assigned: (structured.driver_assigned as boolean) ?? null,
      equipment_assigned: (structured.equipment_assigned as boolean) ?? null,
      pickup_date_confirmed: (structured.pickup_date_confirmed as boolean) ?? null,

      location: (structured.location as string) ?? null,
      eta,
      previous_eta: previousEta,
      eta_changed: previousEta !== null && eta !== null ? previousEta !== eta : null,

      delay: (structured.delay as boolean) ?? null,
      delay_minutes: (structured.delay_minutes as number) ?? null,
      delay_reason: (structured.delay_reason as string) ?? null,
      traffic_issue: (structured.traffic_issue as boolean) ?? null,
      weather_issue: (structured.weather_issue as boolean) ?? null,
      mechanical_issue: (structured.mechanical_issue as boolean) ?? null,
      issue_type: (structured.issue_type as string) ?? null,

      appointment_status:
        (structured.appointment_status as CallResultPayload["result"]["appointment_status"]) ??
        null,

      referred_contact: doc.tool_flags.wrong_contact
        ? {
            name: doc.tool_flags.referred_contact?.name ?? "",
            phone: doc.tool_flags.referred_contact?.phone ?? "",
          }
        : null,
      callback_requested: doc.tool_flags.callback_requested || null,
      callback_time: doc.tool_flags.callback_time ?? null,
      email_requested: doc.tool_flags.email_requested || null,
      requested_email: doc.tool_flags.requested_email ?? null,

      conversation_complete: (structured.conversation_complete as boolean) ?? (answered ? true : null),
      information_collected: answered ? structured : null,

      human_escalation_required: doc.tool_flags.human_escalation_required || null,
      confidence_score: (structured.confidence_score as number) ?? null,
      summary: (structured.summary as string) ?? null,
      next_action: (structured.next_action as string) ?? null,
    },
    recording_url: doc.recording_url ?? null,
    transcript: doc.transcript ?? null,
    started_at: doc.started_at ? doc.started_at.toISOString() : null,
    ended_at: doc.ended_at ? doc.ended_at.toISOString() : null,
  };
}
