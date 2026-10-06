// JSON Schema for Vapi's post-call structured-data extraction
// (analysisPlan.structuredDataPlan). One superset schema shared by every
// shipment on a call, per the confirmed "MDR Agent 3 – Voice API
// Integration Guide" §7A: "Use one common CALL_COMPLETED response
// structure ... Do not change the field names or response structure for
// different call types." Fields irrelevant to a given shipment simply
// extract as null.
//
// CHANGED 2026-09-28: MDR moved from one shipment per call to an array of
// shipments per call. Rather than extracting one flat result for the whole
// call, this now extracts a `shipments` ARRAY — one entry per shipment
// discussed, each shaped like the old single-shipment result plus a
// `shipment_id` to attribute it correctly. Validated empirically the same
// day (throwaway transient-assistant test call, 3 fake shipments discussed
// back-to-back with near-identical phrasing) that Vapi's extraction
// reliably keeps each shipment's answers in its own entry with no
// cross-bleed — see chat history for the raw result. Also folds in the
// driver/dispatcher contact fields from the now-retired
// CONTACT_UPDATE_REQUEST call type's separate schema (contact-detail
// collection is no longer its own call type — see CLAUDE.md's "Contact
// update requests" section).
//
// Every field is nullable EXCEPT confidence_score/call_summary (see below), and
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
// NOTE: `driver`/`dispatcher` apply `nullable: true` to a nested `object`
// type (not just primitives, which is all the single-shipment schema ever
// needed) — this specific combination hasn't been empirically verified
// against a real call the way the array-of-shipments structure has. Watch
// the first real multi-shipment contact-update test for schema validation
// errors or unexpected null-handling here.
//
// `additionalProperties: false` + every field listed in `required` (this
// is NOT the same as "must be non-null" — a field can be required-but-
// nullable) is load-bearing, not decoration: without it, real test calls
// came back with invented field names (e.g. "pickup_date_correct",
// "shipment_problems_safe") loosely copied from the conversation's
// wording instead of our schema's actual property names, while our real
// fields (issue_type, appointment_status, driver_confirmed, ...) were
// dropped. Only confidence_score/call_summary — the two fields that WERE
// required — came through reliably. Keep every property required going
// forward, even ones added later.

export const RESULT_EXTRACTION_PROMPT = `
This call may cover MULTIPLE shipments, discussed one at a time. Produce a
SEPARATE entry in the "shipments" array for every shipment_id actually
discussed on this call — never merge information from different shipments
into one entry, even if their questions/answers looked similar (e.g. two
shipments both "in transit"). Each entry's shipment_id must match exactly
the ID used for that shipment during the call.

FIELD MIX-UP WARNING: a time the caller gives for when DELIVERY happened
(even an uncertain or relative one like "about an hour ago") goes ONLY in
delivery_completed_at. pickup_completed_at is exclusively for a pickup the
caller said was completed — if pickup was never discussed it MUST be null.

TIMESTAMP FORMAT — applies to eta, pickup_completed_at and delivery_completed_at: write it in
exactly this format, 24-hour, zero-padded, always UTC: YYYY-MM-DD HH:MM:SS
(example: 2026-10-06 14:30:00). Nothing else — no "T", no "Z", no AM/PM, no
timezone text. The call took place at: {{call_start_utc}}. Resolve what
the caller said against that moment:
- A relative time ("in 2 hours", "in 30 minutes") -> that call time plus
  that amount.
- A clock time with no day ("5 PM", "2:30 PM") -> that time on the call's
  date. Treat the spoken time as UTC; do not convert timezones.
- A day plus a time ("tomorrow 3 PM", "Friday at 10 AM") -> that calendar
  date (worked out from the call date above) at that time.
- A time in the past for pickup_completed_at/delivery_completed_at ("an hour ago", "2 hours ago", "this morning at 9", "yesterday 4 PM") -> the matching earlier moment, worked out from the call time and date above.
- Vague or incomplete answers ("soon", "later", "this afternoon", a day
  with no time, an unclear fragment) -> null. Never guess a time.

WHO WAS ON THE CALL: {{contact_summary_note}} This is context for call_summary wording ONLY — the person's own details are NOT captured contact information. Fill driver_*/dispatcher_* fields only from details the caller actually stated in answer to a question asking for them; otherwise leave them null.

SINGLE-SHIPMENT CALLS: when a call covers just one shipment, the agent
deliberately does NOT say its shipment ID aloud, so no ID will appear in
the transcript. That is normal — still produce exactly ONE entry
describing the conversation, with shipment_id set to an empty string "".
Never return an empty "shipments" array just because no ID was spoken, as
long as the conversation actually discussed a shipment's status, location,
ETA, delay or delivery.

For every field within a shipment's entry: extract only what the caller
explicitly stated for THAT shipment during this call. Use null for
anything not clearly confirmed for that specific shipment — never infer,
guess, or carry forward a value from a different shipment or from context.

CRITICAL — when the caller DID give a clear, direct answer to a question
that corresponds to one of this schema's fields, you MUST record that
answer in the matching field. Do NOT describe it only in call_summary and
leave the structured field null — that is a mistake, not caution. null is
ONLY for genuinely unclear, unanswered, or not-discussed items, never for
something the caller plainly confirmed or denied. Common mappings, so
there's no ambiguity about where a clear answer belongs:
- "Has a driver been assigned?" -> Yes/No -> driver_assigned: true/false
- "Is the driver contact information updated?" -> Yes -> driver_confirmed: true; No -> driver_confirmed: false. If no driver was assigned (or the question was never asked), driver_confirmed MUST be null.
- When the caller gave a driver's name and phone number because the contact information was NOT updated -> driver_name / driver_phone. driver_phone is written EXACTLY as the digits the caller gave (and read back), e.g. "555 123 4567" — include a leading "+" and country code ONLY if the caller actually said one (e.g. "+91 98765 43210"). Do NOT add a country code yourself, and never prefix "+1": a country code is added afterwards by the system. Leave driver_email null (email is not asked in this flow).
- "Has the required equipment been assigned?" -> Yes/No -> equipment_assigned: true/false
- "Is the scheduled pickup date still correct?" -> Yes/No -> scheduled_pickup_date_correct: true/false
- "Is the appointment confirmed?" -> Yes -> appointment_status: "CONFIRMED"; a clear No/not yet -> "NOT_CONFIRMED"
- "Is there any delay?" -> Yes/No -> delay: true/false (and delay_reason/delay_minutes/issue_type if given). If delay was NEVER asked about or mentioned for that shipment (e.g. it was already delivered, or the call ended first), delay MUST be null — not false. "No delay" is only recorded when the caller actually said so; never infer it from the shipment being delivered or on time.
- A stated cause of a delay -> delay_reason: (the caller's own words) AND issue_type: exactly one of "traffic", "weather", "mechanical", "other" (the single closest category, never several)
- "Has delivery/pickup happened yet?" -> Yes/No -> delivery_completed / pickup_completed: true/false. If that was NEVER asked or stated for a shipment (e.g. a dispatched shipment, where pickup/delivery was not discussed), delivery_completed and pickup_completed MUST be null — never false, never inferred from the shipment's status.
- A stated time of delivery ("delivered at 2 PM", "an hour ago", "yesterday 4 PM") -> delivery_completed_at (timestamp format below); only when delivery_completed is true, otherwise null
- "Where are you now?" / current location stated -> current_location: (the location)
- "What is your current ETA?" / an ETA stated -> eta: (the ETA, in the exact timestamp format described under "TIMESTAMP FORMAT" below — never free text like "5 PM")
- An ETA for delivery stated, and the caller never said it was already delivered -> delivery_completed: false (an ETA means it has not been delivered yet)
If a shipment's entry has several fields left null while its own
call_summary casually states the answers in prose, that is a sign fields
were missed — re-check the transcript for that shipment before finalizing.

IMPORTANT EXCEPTION — confidence_score and call_summary are NOT
caller-stated facts, they are YOUR OWN assessment of THAT shipment's
portion of the call, so the null rule above does NOT apply to them. Always
fill both in for every shipment entry, even when every other field for
that shipment came back null (e.g. a very short or unclear exchange):
- confidence_score: a number from 0.00 to 1.00 reflecting how confident YOU
  are that you correctly understood and extracted THIS SHIPMENT's
  information (based on speech clarity and how directly questions were
  answered) — NOT a shipment-risk or carrier rating. 0.90-1.00 = very
  clear, 0.70-0.89 = reasonably clear, below 0.70 = unclear/uncertain.
  Never leave this null.
- call_summary: 1-2 plain-language sentences describing what was discussed
  for THAT shipment specifically, even if most of its fields are null
  (e.g. "Driver could not confirm an ETA for this shipment."). Never leave
  this null.

For driver_name/driver_phone/driver_email and dispatcher_name/
dispatcher_phone/dispatcher_email within a shipment's entry: only fill
these in if that shipment's conversation actually asked for and captured
driver/dispatcher contact details — this does not apply to most
shipments. Leave all of them null when contact details were never
discussed for that shipment. Same rule as every other field: never guess
or carry a contact from a different shipment.

For human_escalation_required and escalation_reason (per shipment): set
human_escalation_required to true ONLY if that shipment's portion of the
conversation shows one of these specific conditions, per MDR's confirmed
escalation rule —
- truck breakdown or mechanical failure
- an accident
- the driver cannot complete the move
- the carrier says they cannot perform the load
- a pickup/delivery appointment will definitely be missed
- a serious safety issue
- the contact specifically asked for a human
- an important answer could not be confidently understood
- another serious operational issue outside the normal call flow
If none of these apply to that shipment, human_escalation_required must be
false and escalation_reason must be null. If true, escalation_reason must
briefly state which condition applied and why.

For open_issue (per shipment): a brief plain-language description of
anything raised about THAT shipment on this call that is still UNRESOLVED
and should be flagged for follow-up on the NEXT call about it — e.g.
"Container leakage reported, not yet communicated to dispatch." or "Driver
unsure whether appointment was rescheduled, needs confirmation next call."
Use null if that shipment's portion of the call ended with nothing
outstanding to follow up on. This is different from delay_reason/
issue_type, which describe the cause of a delay on THIS call — open_issue
is specifically about what still needs attention going forward.

call_ended_abruptly is about the WHOLE CALL, not any one shipment — true
if the call was cut off or disconnected before reaching a natural
conclusion (e.g. still mid-question with no final reply, or the
conversation just stops with no goodbye), false if it reached a natural
wrap-up (thanks/goodbye said, or the caller clearly finished giving what
they could before the call ended normally). Never leave this null — when
genuinely unsure, false is the safer default.
`.trim();

const SHIPMENT_RESULT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    // Must match the shipment_id used for this shipment during the call —
    // this is how each entry gets attributed back to the right inbound
    // shipment in webhookHandlers.ts.
    shipment_id: { type: "string" },

    driver_confirmed: { type: "boolean", nullable: true },
    driver_assigned: { type: "boolean", nullable: true },
    equipment_assigned: { type: "boolean", nullable: true },

    pickup_completed: { type: "boolean", nullable: true },
    pickup_completed_at: {
      type: "string",
      nullable: true,
      description:
        "When PICKUP was completed, as YYYY-MM-DD HH:MM:SS UTC. Only when the caller said pickup was completed. NEVER put a delivery time here — delivery times go in delivery_completed_at.",
    },
    delivery_completed: { type: "boolean", nullable: true },
    delivery_completed_at: {
      type: "string",
      nullable: true,
      description:
        "When DELIVERY was completed, as YYYY-MM-DD HH:MM:SS UTC. Only when delivery_completed is true and the caller gave a time. This is the ONLY field for a delivery time.",
    },
    // Added 2026-09-29 — DISPATCHED's "Is the scheduled pickup date still
    // correct?" question had no matching field, so this answer either got
    // dropped or the model invented a field name for it (confirmed: real
    // test calls literally invented "pickup_date_correct" before this
    // field existed — see file header comment).
    scheduled_pickup_date_correct: { type: "boolean", nullable: true },

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

    // NOT nullable, unlike every other field above — see the extraction
    // prompt's exception for why.
    confidence_score: { type: "number" },
    call_summary: { type: "string" },
    next_action: { type: "string", nullable: true },

    open_issue: { type: "string", nullable: true },

    // Folded in 2026-09-28 from the retired CONTACT_UPDATE_REQUEST call
    // type — see file header comment. FLATTENED 2026-09-28 (were nested
    // driver/dispatcher: {name, phone, email} objects) after two real test
    // calls showed the extraction becoming unreliable with this schema's
    // size/nesting — one call returned invented field names instead of
    // ours, another returned no structuredData at all. Nested objects are
    // a well-known LLM structured-output reliability risk; flattening is
    // the first, lowest-risk fix being tried before considering a bigger
    // change (e.g. Vapi's newer Structured Outputs API). The OUTBOUND
    // shape to MDR (mdr/types.ts's CommonCallResult.driver/dispatcher)
    // is UNCHANGED — still nested ContactInfo objects, since that's the
    // confirmed external contract; webhookHandlers.ts's buildCommonResult
    // reconstructs the nested shape from these flat fields.
    driver_name: { type: "string", nullable: true },
    driver_phone: { type: "string", nullable: true },
    driver_email: { type: "string", nullable: true },
    dispatcher_name: { type: "string", nullable: true },
    dispatcher_phone: { type: "string", nullable: true },
    dispatcher_email: { type: "string", nullable: true },
    contacts_confirmed: { type: "boolean", nullable: true },
  },
  additionalProperties: false,
  required: [
    "shipment_id",
    "driver_confirmed",
    "driver_assigned",
    "equipment_assigned",
    "pickup_completed",
    "pickup_completed_at",
    "delivery_completed_at",
    "delivery_completed",
    "scheduled_pickup_date_correct",
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
    "call_summary",
    "next_action",
    "open_issue",
    "driver_name",
    "driver_phone",
    "driver_email",
    "dispatcher_name",
    "dispatcher_phone",
    "dispatcher_email",
    "contacts_confirmed",
  ],
} as const;

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    shipments: {
      type: "array",
      items: SHIPMENT_RESULT_ITEM_SCHEMA,
    },
    // Internal-only signal, NOT part of MDR's confirmed result contract —
    // never forwarded to MDR. Whole-call, not per-shipment (see extraction
    // prompt) — exists solely so classifyEventType() in callOutcome.ts can
    // tell CALL_DROPPED/CALL_HANG apart from CALL_COMPLETED: Vapi's
    // endedReason is "customer-ended-call" for BOTH "caller hung up
    // because done" and "call dropped mid-conversation" — the telephony
    // layer can't distinguish them, only the conversation content can.
    call_ended_abruptly: { type: "boolean" },
  },
  additionalProperties: false,
  required: ["shipments", "call_ended_abruptly"],
} as const;
