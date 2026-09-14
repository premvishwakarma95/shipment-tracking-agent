// JSON Schema for Vapi's post-call structured-data extraction
// (analysisPlan.structuredDataPlan). One superset schema shared by all 4
// call types, per the confirmed "MDR Agent 3 – Voice API Integration
// Guide" §7A: "Use one common CALL_COMPLETED response structure ... Do not
// change the field names or response structure for different call types."
// Fields irrelevant to a given call type simply extract as null. Must be
// kept in sync with CommonCallResult in src/mdr/types.ts.
//
// Every field is nullable EXCEPT confidence_score/summary (see below), and
// the extraction prompt is explicit about never inferring a value — this is
// the single place responsible for the "true = confirmed yes, false =
// confirmed no, null = unknown/not asked/not applicable" rule (§7A), since
// this runs once against the finished transcript rather than asking the
// live model to fill in fields mid-conversation (see the "Tool usage
// rules" section of prompt.ts for why that split was made).
//
// Vapi's structured-data schema follows OpenAPI 3.0 conventions: `type`
// must be a single string, not a JSON-Schema-draft-style union array like
// ["string", "null"] (Vapi's assistant-publish validation rejects that).
// Nullability is instead expressed with a separate `nullable: true` flag.
//
// `additionalProperties: false` + every field listed in `required` (this
// is NOT the same as "must be non-null" — a field can be required-but-
// nullable) is load-bearing, not decoration: without it, real test calls
// came back with invented field names (e.g. "pickup_date_correct",
// "shipment_problems_safe") loosely copied from the conversation's
// wording instead of our schema's actual property names, while our real
// fields (issue_type, appointment_status, driver_confirmed, ...) were
// dropped. Only confidence_score/summary — the two fields that WERE
// required — came through reliably. Keep every property required going
// forward, even ones added later.

export const RESULT_EXTRACTION_PROMPT = `
Extract only what the caller explicitly stated during this call. Use null
for anything not clearly confirmed — never infer, guess, or carry forward a
value from context that the caller did not actually say on this call.

IMPORTANT EXCEPTION — confidence_score and summary are NOT caller-stated
facts, they are YOUR OWN assessment of this call, so the null rule above
does NOT apply to them. Always fill both in, even when every other field
came back null (e.g. a very short or unclear call):
- confidence_score: a number from 0.00 to 1.00 reflecting how confident YOU
  are that you correctly understood and extracted this call's information
  (based on speech clarity and how directly questions were answered) — NOT
  a shipment-risk or carrier rating. 0.90-1.00 = very clear, 0.70-0.89 =
  reasonably clear, below 0.70 = unclear/uncertain. Never leave this null.
- summary: 1-2 plain-language sentences describing what happened on this
  call, even if most data fields are null (e.g. "Driver could not confirm
  an ETA."). Never leave this null.
- call_ended_abruptly: true if the call was cut off or disconnected before
  reaching a natural conclusion — e.g. you were still asking a question and
  got no final reply, or the conversation just stops mid-exchange with no
  goodbye. false if the call reached a natural wrap-up (you or the caller
  said something like thanks/goodbye, or the caller clearly finished
  giving what they could before the call ended normally). Never leave this
  null — when genuinely unsure, false is the safer default.

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

    // NOT nullable, unlike every other field above — these are the AI's
    // own assessment of the call, not a caller-stated fact, so "unconfirmed
    // -> null" doesn't apply. required[] below forces the model to always
    // include them.
    confidence_score: { type: "number" },
    summary: { type: "string" },
    next_action: { type: "string", nullable: true },

    // Internal-only signal, NOT part of MDR's confirmed result contract
    // (mdr/types.ts's CommonCallResult) — never forwarded to MDR. Exists
    // solely so classifyEventType() in callOutcome.ts can tell CALL_DROPPED
    // apart from CALL_COMPLETED: Vapi's endedReason is "customer-ended-call"
    // for BOTH "caller hung up because done" and "call dropped mid-
    // conversation" — the telephony layer can't distinguish them, only the
    // conversation content can.
    call_ended_abruptly: { type: "boolean" },
  },
  additionalProperties: false,
  required: [
    "driver_confirmed",
    "driver_assigned",
    "equipment_assigned",
    "pickup_completed",
    "pickup_completed_at",
    "delivery_completed",
    "current_location",
    "eta",
    "delay",
    "delay_minutes",
    "delay_reason",
    "issue_type",
    "appointment_status",
    "human_escalation_required",
    "escalation_reason",
    "confidence_score",
    "summary",
    "next_action",
    "call_ended_abruptly",
  ],
} as const;
