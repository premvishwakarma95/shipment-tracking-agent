// Vapi structured-data extraction schema for CONTACT_UPDATE_REQUEST calls
// ONLY — deliberately separate from resultSchema.ts's RESULT_SCHEMA/
// CommonCallResult. Per the user's explicit direction (2026-09-24): this
// call type's result nests driver/dispatcher contact info and doesn't fit
// the "one common structure" rule the other four call types share.
// Applied per-call via assistantOverrides.analysisPlan (see
// src/server/mdrCallRequest.ts) — the shared assistant's default
// analysisPlan (resultSchema.ts) is untouched and still applies to every
// other call type.
//
// Same conventions as resultSchema.ts, applied to nested objects too:
// `nullable: true` (never a `["string","null"]` union — Vapi's
// OpenAPI-3.0-style validation rejects that), `additionalProperties:
// false` + every property `required` (including nested driver/dispatcher
// sub-objects) to prevent the extraction from inventing ad hoc field
// names instead of using ours — see resultSchema.ts's comment for the
// real bug this convention was fixed for.

const CONTACT_SUB_SCHEMA = {
  type: "object",
  nullable: true,
  properties: {
    name: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    email: { type: "string", nullable: true },
  },
  additionalProperties: false,
  required: ["name", "phone", "email"],
} as const;

export const CONTACT_UPDATE_EXTRACTION_PROMPT = `
Extract only what the caller explicitly stated during this call. Use null
for anything not clearly confirmed — never infer, guess, or carry forward a
value from context that the caller did not actually say on this call.

- driver: the current driver's name, phone, and email, each null
  individually if not given (e.g. name given but no email — email stays
  null, do not null out the whole object). Null the whole driver object
  only if nothing about the driver was discussed at all.
- dispatcher: same rule, for the current dispatcher.
- contacts_confirmed: true ONLY if the caller explicitly confirmed these
  are the best/correct contacts for future shipment updates (the call's
  third question). false if they explicitly said these are NOT the best
  contacts. null if not addressed or unclear.
- An email address is easy to mishear over a phone call. If the caller
  gave one, only record it if it was confirmed by having them spell it out
  or by reading it back and getting an explicit yes — otherwise leave the
  email null even if something was said, rather than recording an
  uncertain guess.

IMPORTANT EXCEPTION — confidence_score and call_summary are NOT
caller-stated facts, they are YOUR OWN assessment of this call, so the null
rule above does NOT apply to them. Always fill both in, even when driver/
dispatcher came back null (e.g. a very short or unclear call):
- confidence_score: a number from 0.00 to 1.00 reflecting how confident YOU
  are that you correctly understood and extracted this call's information
  — NOT a shipment-risk or carrier rating. 0.90-1.00 = very clear, 0.70-0.89
  = reasonably clear, below 0.70 = unclear/uncertain. Never leave this null.
- call_summary: 1-2 plain-language sentences describing what happened on
  this call. Never leave this null.
- call_ended_abruptly: true if the call was cut off or disconnected before
  reaching a natural conclusion. false if it reached a natural wrap-up.
  Never leave this null — when genuinely unsure, false is the safer
  default. (Internal-only signal, not forwarded to MDR — same mechanism as
  the other call types', see src/server/callOutcome.ts.)

For human_escalation_required and escalation_reason: set
human_escalation_required to true ONLY if the conversation shows one of
MDR's confirmed escalation conditions (see prompt.ts's Escalation section)
— the same rule applies on this call type as every other. If none apply,
human_escalation_required must be false and escalation_reason must be
null.

For next_action: a brief machine-usable next step if one is obvious from
the call (e.g. "UPDATE_CONTACTS" if new contact info was captured), null
if nothing specific applies.

For open_issue: same meaning as on every other call type — a brief
description of anything still unresolved that should be flagged for the
next call to this shipment/contact. Null if nothing outstanding.
`.trim();

export const CONTACT_UPDATE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    driver: CONTACT_SUB_SCHEMA,
    dispatcher: CONTACT_SUB_SCHEMA,
    contacts_confirmed: { type: "boolean", nullable: true },

    // Not nullable — the AI's own assessment, always populated. Same
    // pattern as resultSchema.ts's RESULT_SCHEMA.
    confidence_score: { type: "number" },
    call_summary: { type: "string" },

    human_escalation_required: { type: "boolean", nullable: true },
    escalation_reason: { type: "string", nullable: true },
    next_action: { type: "string", nullable: true },
    open_issue: { type: "string", nullable: true },

    // Internal-only, not forwarded to MDR — see resultSchema.ts's
    // RESULT_SCHEMA for why this exists (classifyEventType's CALL_DROPPED
    // vs CALL_COMPLETED disambiguation).
    call_ended_abruptly: { type: "boolean" },
  },
  additionalProperties: false,
  required: [
    "driver",
    "dispatcher",
    "contacts_confirmed",
    "confidence_score",
    "call_summary",
    "human_escalation_required",
    "escalation_reason",
    "next_action",
    "open_issue",
    "call_ended_abruptly",
  ],
} as const;

// Ready to pass as CreateCallParams.analysisPlan (src/vapi/calls.ts) —
// same shape as the assistant's default analysisPlan in create.ts, just
// with this call type's schema/prompt instead.
export const CONTACT_UPDATE_ANALYSIS_PLAN = {
  structuredDataPlan: {
    enabled: true,
    schema: CONTACT_UPDATE_RESULT_SCHEMA,
    messages: [
      { role: "system", content: CONTACT_UPDATE_EXTRACTION_PROMPT },
      { role: "user", content: "Call transcript:\n\n{{transcript}}" },
    ],
  },
};
