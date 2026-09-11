import type { CallStatus } from "../mdr/types.js";
import type { CallRequestDoc } from "../db/models/CallRequest.js";

type ToolFlags = CallRequestDoc["tool_flags"];

// Allowlist, not denylist (same convention as the reference project):
// anything we don't explicitly recognize maps to the conservative
// CALL_FAILED rather than being assumed successful.
const ENDED_REASON_MAP: Record<string, CallStatus> = {
  "assistant-ended-call": "COMPLETED",
  "customer-ended-call": "COMPLETED",
  "assistant-forwarded-call": "COMPLETED",
  "silence-timed-out": "CALL_DROPPED",
  "customer-did-not-give-microphone-permission": "CALL_FAILED",
  "phone-call-provider-closed-websocket": "CALL_DROPPED",
  "pipeline-error": "CALL_FAILED",
  "voicemail": "LEFT_VOICEMAIL",
  "customer-busy": "BUSY",
  "no-answer": "NO_ANSWER",
};

// Tool flags are known immediately (mid-call); the endedReason-derived
// default is only known once Vapi's end-of-call-report arrives. Tool flags
// take precedence when they represent one of MDR's own call_status values
// — wrong contact / callback / email request are outcomes in their own
// right, not just annotations on a COMPLETED call. human_escalation is
// NOT one of these: it stays a boolean flag on the result, it doesn't
// change call_status.
export function classifyCallStatus(
  endedReason: string | undefined,
  toolFlags: ToolFlags | undefined,
): CallStatus {
  if (toolFlags?.wrong_contact) return "WRONG_CONTACT";
  if (toolFlags?.callback_requested) return "CALLBACK_REQUESTED";
  if (toolFlags?.email_requested) return "EMAIL_REQUESTED";

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
