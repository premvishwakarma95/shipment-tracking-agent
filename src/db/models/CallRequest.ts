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

// The vocabulary MDR expects back. Kept flat here rather than split into an
// internal enum + a translation layer (contrast the reference project's
// mapToMdrCallLogStatus) because MDR's enum already IS the target
// vocabulary — there's nothing to translate.
export const CALL_STATUSES = [
  "COMPLETED",
  "NO_ANSWER",
  "LEFT_VOICEMAIL",
  "BUSY",
  "CALL_FAILED",
  "CALL_DROPPED",
  "WRONG_CONTACT",
  "CALLBACK_REQUESTED",
  "EMAIL_REQUESTED",
] as const;

// Internal-only bookkeeping for where THIS record is in its own lifecycle.
// Deliberately a separate field from call_status (the MDR-facing outcome)
// — do not collapse the two. lifecycle_status answers "have we heard back
// from Vapi yet?"; call_status answers "what happened on the call?".
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
    callback_time: { type: String, default: null },
    email_requested: { type: Boolean, default: false },
    requested_email: { type: String, default: null },
    human_escalation_required: { type: Boolean, default: false },
  },
  { _id: false },
);

// Intentionally thin: this model exists only to bridge the async gap
// between "we told Vapi to dial" and "Vapi's webhooks tell us what
// happened," a few minutes later. It is NOT a cross-call history store —
// MDR supplies previous_interactions/open_items on every request instead
// of Voice API querying its own past attempts (contrast the reference
// project's callMemory.ts, which had to do that lookup itself).
const CallRequestSchema = new Schema(
  {
    mdr_call_id: { type: String, required: true, unique: true },
    call_type: { type: String, enum: CALL_TYPES, required: true },
    contact: { type: ContactSchema, required: true },
    // Permissive on purpose: MDR may send additional TAI shipment/reference
    // fields (references, timing, alerts, documents) beyond the example in
    // the spec. Don't lock this down to a strict sub-schema.
    shipment: { type: Schema.Types.Mixed, required: true },
    previous_interactions: { type: [Schema.Types.Mixed], default: [] },
    open_items: { type: [String], default: [] },

    vapi_call_id: { type: String, index: true, sparse: true },
    lifecycle_status: {
      type: String,
      enum: LIFECYCLE_STATUSES,
      default: "PENDING",
    },

    // Set mid-call, as soon as the LLM calls the corresponding tool.
    tool_flags: { type: ToolFlagsSchema, default: () => ({}) },

    // Raw output of Vapi's post-call structured-data extraction
    // (see src/assistant/resultSchema.ts), kept unparsed alongside the
    // assembled result actually sent to MDR.
    structured_result: { type: Schema.Types.Mixed, default: null },

    call_status: { type: String, enum: CALL_STATUSES, default: null },
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
