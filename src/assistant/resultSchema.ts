// JSON Schema for Vapi's post-call structured-data extraction
// (analysisPlan.structuredDataPlan). One superset schema shared by all 4
// call types, per the confirmed "MDR Agent 3 – Voice API Integration
// Guide" §7A: "Use one common CALL_COMPLETED response structure ... Do not
// change the field names or response structure for different call types."
// Fields irrelevant to a given call type simply extract as null. Must be
// kept in sync with CommonCallResult in src/mdr/types.ts.
//
// Every field is nullable, and the extraction prompt below is explicit
// about never inferring a value — this is the single place responsible for
// the "true = confirmed yes, false = confirmed no, null = unknown/not
// asked/not applicable" rule (§7A), since this runs once against the
// finished transcript rather than asking the live model to fill in fields
// mid-conversation (see the "Tool usage rules" section of prompt.ts for
// why that split was made).
//
// Vapi's structured-data schema follows OpenAPI 3.0 conventions: `type`
// must be a single string, not a JSON-Schema-draft-style union array like
// ["string", "null"] (Vapi's assistant-publish validation rejects that).
// Nullability is instead expressed with a separate `nullable: true` flag.

export const RESULT_EXTRACTION_PROMPT = `
Extract only what the caller explicitly stated during this call. Use null
for anything not clearly confirmed — never infer, guess, or carry forward a
value from context that the caller did not actually say on this call.

For human_escalation_required and escalation_reason: set
human_escalation_required to true ONLY if the conversation shows one of
these specific conditions, per MDR's confirmed escalation rule —
- truck breakdown or mechanical failure
- an accident
- the driver cannot complete the move
- the carrier says they cannot perform the load
- a pickup/delivery appointment will definitely be missed
- a serious safety issue
- the contact specifically asked for a human
- an important answer could not be confidently understood
- another serious operational issue outside the normal call flow
If none of these apply, human_escalation_required must be false and
escalation_reason must be null. If true, escalation_reason must briefly
state which condition applied and why.
`.trim();

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    driver_confirmed: { type: "boolean", nullable: true },
    driver_assigned: { type: "boolean", nullable: true },
    equipment_assigned: { type: "boolean", nullable: true },

    pickup_completed: { type: "boolean", nullable: true },
    pickup_completed_at: { type: "string", nullable: true },
    delivery_completed: { type: "boolean", nullable: true },

    current_location: { type: "string", nullable: true },
    eta: { type: "string", nullable: true },

    delay: { type: "boolean", nullable: true },
    delay_minutes: { type: "number", nullable: true },
    delay_reason: { type: "string", nullable: true },
    issue_type: { type: "string", nullable: true },

    appointment_status: {
      type: "string",
      nullable: true,
      enum: ["CONFIRMED", "NOT_CONFIRMED", "COMPLETED", "MISSED", "UNKNOWN"],
    },

    human_escalation_required: { type: "boolean", nullable: true },
    escalation_reason: { type: "string", nullable: true },

    confidence_score: { type: "number", nullable: true },
    summary: { type: "string", nullable: true },
    next_action: { type: "string", nullable: true },
  },
  required: [],
} as const;
