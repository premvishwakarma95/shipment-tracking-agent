// JSON Schema for Vapi's post-call structured-data extraction
// (analysisPlan.structuredDataPlan). One superset schema across all 4 call
// types — fields irrelevant to a given call type simply extract as null,
// which matches the spec's own "not every field applies to every call"
// note (§19). Must be kept in sync with CallResultPayload["result"] in
// src/mdr/types.ts.
//
// Every field is nullable, and the extraction prompt below is explicit
// about never inferring a value — this is the single place responsible for
// the spec's hard "never fabricate, null if unknown" requirement, since
// this runs once against the finished transcript rather than asking the
// live model to fill in fields mid-conversation (see the "Tool usage
// rules" section of prompt.ts for why that split was made).

export const RESULT_EXTRACTION_PROMPT = `
Extract only what the caller explicitly stated during this call. Use null
for anything not clearly confirmed — never infer, guess, or carry forward a
value from context that the caller did not actually say on this call.
`.trim();

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    driver_confirmed: { type: ["boolean", "null"] },
    driver_assigned: { type: ["boolean", "null"] },
    equipment_assigned: { type: ["boolean", "null"] },
    pickup_date_confirmed: { type: ["boolean", "null"] },

    location: { type: ["string", "null"] },
    eta: { type: ["string", "null"] },
    eta_changed: { type: ["boolean", "null"] },

    delay: { type: ["boolean", "null"] },
    delay_minutes: { type: ["number", "null"] },
    delay_reason: { type: ["string", "null"] },
    traffic_issue: { type: ["boolean", "null"] },
    weather_issue: { type: ["boolean", "null"] },
    mechanical_issue: { type: ["boolean", "null"] },
    issue_type: { type: ["string", "null"] },

    appointment_status: {
      type: ["string", "null"],
      enum: ["CONFIRMED", "AT_RISK", "UNKNOWN", null],
    },

    conversation_complete: { type: ["boolean", "null"] },

    confidence_score: { type: ["number", "null"] },
    summary: { type: ["string", "null"] },
    next_action: { type: ["string", "null"] },
  },
  required: [],
} as const;
