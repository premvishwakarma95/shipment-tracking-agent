import { Schema, model, type InferSchemaType } from "mongoose";

export const CALL_TYPES = [
  "OUT_FOR_DELIVERY",
  "PICKUP_TODAY",
  "DISPATCHED",
  "IN_TRANSIT",
] as const;

export const CONTACT_TYPES = [
  "DRIVER",
  "DISPATCHER",
  "SECONDARY_DISPATCHER",
  "CARRIER_MAIN",
  "AFTER_HOURS",
] as const;

// The event_type vocabulary confirmed in the MDR Agent 3 Voice API
// Integration Guide (§5, §10, §13). NOTE: EMAIL_REQUESTED is deliberately
// NOT here — that doc's webhook event list doesn't include it. We still
// capture an email request internally (tool_flags.email_requested) but
// fold it into whichever real event's summary we do send, until MDR
// confirms whether it needs its own event — see docs/requirements-tracker.md.
export const EVENT_TYPES = [
  "NO_ANSWER",
  "VOICEMAIL",
  "BUSY",
  "CALL_FAILED",
  "CALL_DROPPED",
  "CALLBACK_REQUESTED",
  "WRONG_CONTACT",
  "CALL_COMPLETED",
] as const;

// Internal-only bookkeeping for where THIS record is in its own lifecycle.
// Deliberately a separate field from event_type (the MDR-facing outcome)
// — do not collapse the two. lifecycle_status answers "have we heard back
// from Vapi yet?"; event_type answers "what happened on the call?".
export const LIFECYCLE_STATUSES = [
  "PENDING",
  "CALLING",
  "COMPLETED",
  "FAILED",
] as const;

const ContactSchema = new Schema(
  {
    type: { type: String, enum: CONTACT_TYPES, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const ToolFlagsSchema = new Schema(
  {
    wrong_contact: { type: Boolean, default: false },
    referred_contact: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
    },
    callback_requested: { type: Boolean, default: false },
    // Confirmed contract wants a number of minutes, not free text.
    callback_after_minutes: { type: Number, default: null },
    // No confirmed MDR event_type for this yet — kept for visibility only.
    email_requested: { type: Boolean, default: false },
    requested_email: { type: String, default: null },
    human_escalation_required: { type: Boolean, default: false },
    escalation_reason: { type: String, default: null },
  },
  { _id: false },
);

// Intentionally thin: this model exists only to bridge the async gap
// between "we told Vapi to dial" and "Vapi's webhooks tell us what
// happened," a few minutes later. It is NOT a cross-call history store —
// MDR supplies previous_summary/open_issue on every request instead of
// Voice API querying its own past attempts (contrast the reference
// project's callMemory.ts, which had to do that lookup itself).
const CallRequestSchema = new Schema(
  {
    mdr_call_id: { type: String, required: true, unique: true },
    call_type: { type: String, enum: CALL_TYPES, required: true },
    contact: { type: ContactSchema, required: true },
    // Permissive on purpose: MDR may send additional TAI shipment/reference
    // fields beyond the confirmed example. Don't lock this down to a strict
    // sub-schema.
    shipment: { type: Schema.Types.Mixed, required: true },
    // Singular strings per the confirmed integration guide (§9) — NOT the
    // previous_interactions[]/open_items[] arrays from the earlier informal
    // spec. Renamed here to match.
    previous_summary: { type: String, default: null },
    open_issue: { type: String, default: null },
    // New in the confirmed contract (§3): MDR now tells us explicitly which
    // questions it wants answered on this call, in addition to the default
    // per-call-type set in prompt.ts.
    questions: { type: [String], default: [] },

    vapi_call_id: { type: String, index: true, sparse: true },
    // Live Call Control URL for this specific call (docs.vapi.ai/calls/
    // call-features) — lets webhookHandlers.ts inject a deterministic
    // spoken message + hangup mid-call (see src/vapi/callControl.ts).
    control_url: { type: String, default: null },
    lifecycle_status: {
      type: String,
      enum: LIFECYCLE_STATUSES,
      default: "PENDING",
    },

    // Set mid-call, as soon as the LLM calls the corresponding tool.
    tool_flags: { type: ToolFlagsSchema, default: () => ({}) },

    // Raw output of Vapi's post-call structured-data extraction
    // (see src/assistant/resultSchema.ts), kept unparsed alongside the
    // assembled event actually sent to MDR.
    structured_result: { type: Schema.Types.Mixed, default: null },

    event_type: { type: String, enum: EVENT_TYPES, default: null },
    recording_url: { type: String, default: null },
    transcript: { type: String, default: null },
    started_at: { type: Date, default: null },
    ended_at: { type: Date, default: null },

    // Idempotency guard for the push to MDR — same pattern as the
    // reference project's mdrCallLogSubmittedAt. Null means "not yet
    // pushed" (either still in flight, or the push attempt failed and is
    // waiting on manual reconciliation — see docs/requirements-tracker.md,
    // there's no retry queue in v1).
    mdr_pushed_at: { type: Date, default: null },

    received_at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

export type CallRequestDoc = InferSchemaType<typeof CallRequestSchema>;

export const CallRequest = model("CallRequest", CallRequestSchema);
