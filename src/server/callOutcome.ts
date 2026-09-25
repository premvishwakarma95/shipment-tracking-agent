import type { EventType } from "../mdr/types.js";
import type { CallRequestDoc } from "../db/models/CallRequest.js";
import { END_CALL_MESSAGE } from "../assistant/prompt.js";

type ToolFlags = CallRequestDoc["tool_flags"];

// Derived from END_CALL_MESSAGE, NOT a separately hardcoded copy — if MDR
// ever changes the closing wording, this stays in sync automatically since
// it reads the live constant instead of a second string someone has to
// remember to update. First sentence only (not the full message with
// punctuation) so minor ASR transcription noise doesn't break the match.
const COMPLETION_SIGNAL = END_CALL_MESSAGE.split(".")[0].trim();

// Allowlist, not denylist (same convention as the reference project):
// anything we don't explicitly recognize maps to the conservative
// CALL_FAILED rather than being assumed successful.
//
// CALL_DROPPED vs CALL_HANG (added 2026-09-24, confirmed with MDR/user):
// CALL_DROPPED is now reserved for endedReasons Vapi explicitly attributes
// to a technical/connection failure (phone-call-provider-closed-websocket
// is the one confirmed example) — NOT an inferred/ambiguous case. Anything
// where a person just stopped engaging (silence timeout) or disconnected
// without a technical signal maps to CALL_HANG instead — see the
// classifyEventType logic below for the inferred cases (empty transcript,
// abrupt customer-ended-call).
const ENDED_REASON_MAP: Record<string, EventType> = {
  "assistant-ended-call": "CALL_COMPLETED",
  "customer-ended-call": "CALL_COMPLETED",
  "assistant-forwarded-call": "CALL_COMPLETED",
  "silence-timed-out": "CALL_HANG",
  "customer-did-not-give-microphone-permission": "CALL_FAILED",
  "phone-call-provider-closed-websocket": "CALL_DROPPED",
  "pipeline-error": "CALL_FAILED",
  "voicemail": "VOICEMAIL",
  "customer-busy": "BUSY",
  // Confirmed empirically 2026-09-14 (TEST-009): Vapi's real endedReason
  // for an unanswered call is "customer-did-not-answer", not "no-answer" —
  // without this the console warned "unrecognized endedReason" and every
  // real no-answer call was silently reported to MDR as CALL_FAILED
  // instead of NO_ANSWER. Kept "no-answer" too in case an older/different
  // Vapi path still sends it — cheap to keep both mapped correctly.
  "customer-did-not-answer": "NO_ANSWER",
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
//
// "customer-ended-call" is Vapi's ambiguous endedReason — the SAME string
// whether the caller finished normally or the call dropped mid-sentence
// (confirmed empirically 2026-09-14, TEST-014). ENDED_REASON_MAP alone
// can't tell those apart, so classifyEventType below checks the transcript
// for COMPLETION_SIGNAL as the deterministic tiebreaker.
//
// `callEndedAbruptly` (the post-call structured extraction's own guess,
// see resultSchema.ts's `call_ended_abruptly`) is kept as a SECONDARY
// signal only, OR'd alongside the transcript check — not trusted alone
// anymore. Confirmed unreliable 2026-09-24/25 (MDR's own test call,
// mdr_call_id A3-UNEEJXYRVWTW: transcript was an obvious abrupt cutoff
// after only a fragment of the AI's greeting, zero customer speech, and
// the extraction's OWN call_summary described it as such — but it still
// returned call_ended_abruptly: false). Don't go back to trusting that
// field alone for this decision.
export function classifyEventType(
  endedReason: string | undefined,
  toolFlags: ToolFlags | undefined,
  callEndedAbruptly?: boolean,
  transcript?: string | null,
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

  if (mapped === "CALL_COMPLETED") {
    // A genuinely completed call implies the caller said SOMETHING. An
    // empty transcript means the call connected then ended with zero
    // customer speech (e.g. picked up and immediately hung up). Confirmed
    // empirically 2026-09-23 (TEST-SILENT-005): the extraction left it
    // uncaught, reported CALL_COMPLETED on transcript: "". CALL_HANG, not
    // CALL_DROPPED — Vapi gave us no technical-failure signal here, this
    // is the customer disconnecting without engaging.
    if (!transcript || transcript.trim().length === 0) {
      return "CALL_HANG";
    }

    // Same reasoning, broadened (added 2026-09-25 per MDR's report,
    // mdr_call_id A3-UNEEJXYRVWTW — see comment above): it's not just a
    // fully empty transcript that's suspect. ANY "customer-ended-call"
    // where the conversation didn't actually reach the assistant's own
    // closing line is either zero engagement OR a partially-answered call
    // cut short before finishing — neither is a real completion. Check
    // deterministically for COMPLETION_SIGNAL in the transcript instead of
    // trusting endedReason alone; call_ended_abruptly is kept as a second,
    // OR'd signal in case the extraction catches something this text
    // check doesn't. CALL_HANG, not CALL_DROPPED — same reasoning as
    // above: no technical-failure signal from Vapi, so this defaults to
    // CALL_HANG, and CALL_DROPPED stays reserved for endedReasons that
    // explicitly indicate a technical failure (e.g.
    // phone-call-provider-closed-websocket above).
    if (endedReason === "customer-ended-call") {
      const reachedClosing = transcript.includes(COMPLETION_SIGNAL);
      if (!reachedClosing || callEndedAbruptly) {
        return "CALL_HANG";
      }
    }
  }

  return mapped;
}
