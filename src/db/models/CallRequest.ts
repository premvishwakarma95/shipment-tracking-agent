import { Schema, model, type InferSchemaType } from "mongoose";

export const CONTACT_TYPES = [
  "DRIVER",
  "DISPATCHER",
  "SECONDARY_DISPATCHER",
  "CARRIER_MAIN",
  "AFTER_HOURS",
  // Added 2026-09-24 for contact-update-style calls — confirmed spelling
  // (underscore, no space) by the user 2026-09-24; MDR's own example
  // payload sent "CARRIER REPRESENTATIVE" with a space, which doesn't
  // match this enum's SCREAMING_SNAKE_CASE convention.
  "CARRIER_REPRESENTATIVE",
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
  // Added 2026-09-24 per MDR's request — splits what used to be one
  // CALL_DROPPED bucket in two: CALL_DROPPED now means a genuine
  // technical/network failure (Vapi explicitly told us the connection
  // broke), CALL_HANG means the customer intentionally disconnected
  // without engaging (silence timeout, empty-transcript hangup, or an
  // abrupt mid-call cutoff with no technical signal from Vapi). See
  // classifyEventType in callOutcome.ts and CLAUDE.md's "CALL_DROPPED vs
  // CALL_HANG" section for the exact mapping — confirmed with MDR/user
  // 2026-09-24, don't reclassify a path between the two without the same
  // kind of explicit confirmation.
  "CALL_HANG",
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
    // Call-level only (never scoped to one shipment) — see mdr/types.ts's
    // CommonCallResult.human_escalation_required comment for why this
    // isn't merged into any individual shipment's result.
    human_escalation_required: { type: Boolean, default: false },
    escalation_reason: { type: String, default: null },
  },
  { _id: false },
);

// Intentionally thin: this model exists only to bridge the async gap
// between "we told Vapi to dial" and "Vapi's webhooks tell us what
// happened," a few minutes later. It is NOT a cross-call history store —
// MDR supplies previous_summary/open_issue per shipment on every request
// instead of Voice API querying its own past attempts (contrast the
// reference project's callMemory.ts, which had to do that lookup itself).
const CallRequestSchema = new Schema(
  {
    mdr_call_id: { type: String, required: true, unique: true },
    // Deliberately a plain string, NOT an enum. Currently always
    // "SHIPMENT_GROUP" — MDR has said this value is for their own internal
    // use and may change, so it's captured/echoed back but never
    // validated against a fixed set or acted on. See mdr/types.ts's
    // CallRequestPayload.call_type comment.
    call_type: { type: String, required: true },
    contact: { type: ContactSchema, required: true },
    // CHANGED 2026-09-28: MDR moved from one shipment per call request to
    // an array of shipments per call (sometimes still just one), so
    // details for all of them can be collected in a single conversation.
    // Each entry stays Schema.Types.Mixed, permissive on purpose — MDR may
    // send additional TAI shipment/reference fields beyond the confirmed
    // example (shipment_id, status, pickup_date,
    // estimated_delivery_date, delivery_appointment, carrier_name,
    // questions[], previous_summary, open_issue). Don't lock this down to
    // a strict sub-schema.
    shipments: { type: [Schema.Types.Mixed], required: true },

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

    // Per-shipment results array — an array directly, not wrapped in a
    // `{ shipments: [...] }` object (RESTRUCTURED 2026-09-29 per the
    // user's direction; call_ended_abruptly is its own top-level field
    // below instead of nested in here). NOT the raw Vapi extraction
    // output anymore as of the same day — each entry is
    // `{ shipment_id, status, ...resultFields }` (result fields spread
    // directly, no `result` wrapper — that wrapper is specific to the
    // outbound MDR contract, VoiceWebhookEvent's ShipmentResult, not
    // wanted here), built from webhookHandlers.ts's buildShipmentResults,
    // the SAME function used for the actual outbound MDR payload, so the
    // field VALUES mirror that exactly (nested driver/dispatcher: {name,
    // phone, email}, matching MDR's required contract) rather than
    // resultSchema.ts's flat extraction shape (driver_name/driver_phone/
    // ... — kept flat there on purpose, for extraction reliability; see
    // that file's header comment).
    structured_result: { type: Schema.Types.Mixed, default: null },
    // Whole-call signal (not per-shipment, see resultSchema.ts's extraction
    // prompt) used by classifyEventType() in callOutcome.ts — pulled out to
    // its own top-level field 2026-09-29 so it's directly queryable instead
    // of nested inside structured_result.
    call_ended_abruptly: { type: Boolean, default: null },

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
