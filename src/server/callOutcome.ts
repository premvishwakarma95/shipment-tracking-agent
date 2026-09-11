import type { EventType } from "../mdr/types.js";
import type { CallRequestDoc } from "../db/models/CallRequest.js";

type ToolFlags = CallRequestDoc["tool_flags"];

// Allowlist, not denylist (same convention as the reference project):
// anything we don't explicitly recognize maps to the conservative
// CALL_FAILED rather than being assumed successful.
const ENDED_REASON_MAP: Record<string, EventType> = {
  "assistant-ended-call": "CALL_COMPLETED",
  "customer-ended-call": "CALL_COMPLETED",
  "assistant-forwarded-call": "CALL_COMPLETED",
  "silence-timed-out": "CALL_DROPPED",
  "customer-did-not-give-microphone-permission": "CALL_FAILED",
  "phone-call-provider-closed-websocket": "CALL_DROPPED",
  "pipeline-error": "CALL_FAILED",
  "voicemail": "VOICEMAIL",
  "customer-busy": "BUSY",
  "no-answer": "NO_ANSWER",
};

// Tool flags are known immediately (mid-call); the endedReason-derived
// default is only known once Vapi's end-of-call-report arrives. Tool flags
// take precedence when they represent one of MDR's own event_type values
// — wrong contact / callback are outcomes in their own right, not just
// annotations on a completed call. human_escalation is NOT one of these:
// it stays a boolean field on the CALL_COMPLETED result, it doesn't change
// the event_type (there's no ESCALATION event in the confirmed contract).
//
// NOTE: email_requested is deliberately NOT checked here — the confirmed
// MDR Agent 3 Voice API Integration Guide's webhook event list has no
// EMAIL_REQUESTED event. See docs/requirements-tracker.md.
export function classifyEventType(
  endedReason: string | undefined,
  toolFlags: ToolFlags | undefined,
): EventType {
  if (toolFlags?.wrong_contact) return "WRONG_CONTACT";
  if (toolFlags?.callback_requested) return "CALLBACK_REQUESTED";

  if (!endedReason) {
    console.warn("[callOutcome] missing endedReason, defaulting to CALL_FAILED");
    return "CALL_FAILED";
  }

  const mapped = ENDED_REASON_MAP[endedReason];
  if (!mapped) {
    console.warn(`[callOutcome] unrecognized endedReason "${endedReason}", defaulting to CALL_FAILED`);
    return "CALL_FAILED";
  }

  return mapped;
}
