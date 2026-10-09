# Business Requirements Digest

Sources: "MDR Agent 3 – Instructions for Voice API Team" (original informal
spec) and "MDR Agent 3 – Voice API Integration Guide, Updated developer
version" (the confirmed contract — supersedes the original spec wherever
they disagree). This is a short digest for onboarding — the guide itself is
the source of truth for exact wording/examples; `docs/requirements-tracker.md`
tracks what's confirmed vs. still open.

## Responsibility split

MDR decides **who** to call and **why**. Voice API (this service) makes
**one** call per request, conducts the conversation, and reports back a
result via MDR's webhook. Voice API never picks the next contact, never
retries on its own, never auto-dials a referred number, and never
self-schedules a callback — all of that is MDR's decision.

API = MDR calls Voice Team (`POST /mdr/call-requests`).
Webhook = Voice Team calls MDR (`POST https://staging.mydrayrate.com/api/voice/check-call-completed`, Bearer auth, confirmed by MDR 2026-09-16).

## What MDR sends per call

One contact (type: DRIVER / DISPATCHER / SECONDARY_DISPATCHER /
CARRIER_MAIN / AFTER_HOURS / CARRIER_REPRESENTATIVE — exact values, anything
else is rejected with a 400) and a `shipments[]` array (one or more
shipments for that contact). Each shipment carries its own `status`,
`questions[]` list of what MDR wants asked, and `previous_summary`/
`open_issue` — prior context to avoid starting from zero every call.

## Call types

UPDATED 2026-09-29 — these are no longer selected by a request-level
`call_type` (retired along with the old single-shipment format; see
CLAUDE.md's "Multi-shipment calls" section). Each shipment within a
`SHIPMENT_GROUP` request now carries its own `status`, matched against
these same five sets in `src/assistant/prompt.ts`'s `STATUS_QUESTIONS`.
Content below reflects MDR's 2026-09-29 revised wording (`STATUS_QUESTIONS`
is the source of truth — keep this digest in sync with it, not the other
way around):

- **OUT_FOR_DELIVERY** — Where are you now? Current ETA? Any delay (if yes,
  the cause: traffic / weather / mechanical / other)? Has delivery happened
  yet — asked only if no ETA/delay/"delivered" was already given; if
  delivered, what date and time.
- **PICKUP_TODAY** — Has a driver been assigned? If yes: is the driver
  contact information updated? (if not, driver name and phone). Driver's
  ETA to pickup (skipped when no driver is assigned). Pickup appointment
  confirmed? Any delay with the pickup?
- **DISPATCHED** — Has a driver been assigned? If yes: is the driver
  contact information updated? (if not, driver name and phone). Equipment
  assigned? Scheduled pickup date still correct? Appointment confirmed? Any
  delay with the shipment?
- **IN_TRANSIT** — Where are you now? Current ETA? Any delay (and its
  cause)?
- **Dispatcher contacts** (`DISPATCHER`, `SECONDARY_DISPATCHER`) are asked
  about the driver in the third person for OUT_FOR_DELIVERY and IN_TRANSIT
  ("Where is the driver currently?", "What is the driver's current ETA?",
  "Is there any delay with the delivery?", "Has delivery happened yet?").
  Every other contact type gets the wording above. `call_summary` names the
  actual person on the call.
- **CONTACT_UPDATE_REQUEST** — no longer a separate call type (merged into
  the common `SHIPMENT_GROUP` format, only reachable via a shipment's own
  `status`). Driver's name/phone/email, dispatcher's name/phone/email
  (asked one at a time, not bundled), whether these are the best contacts.

## Escalation

Voice's LLM decides `human_escalation_required` from what the carrier/driver
actually said — MDR confirmed this is a defined, closed list of triggers,
not an open judgment call:

- truck breakdown / mechanical failure
- an accident
- the driver cannot complete the move
- the carrier says they cannot perform the load
- a pickup/delivery appointment will definitely be missed
- a serious safety issue
- the contact specifically asks for a human
- an important answer cannot be confidently understood
- another serious operational issue not covered by the normal flow

If one of these applies: `human_escalation_required: true` and
`escalation_reason` briefly states which condition and why, e.g.:

```json
{ "human_escalation_required": true, "escalation_reason": "Truck breakdown. Driver cannot provide a reliable ETA." }
```

If none apply (the normal case): `human_escalation_required: false`,
`escalation_reason: null`. A routine delay or a "not sure yet" answer is
NOT on its own grounds for escalation. Implemented via two combined
signals — the `flagHumanEscalation` tool (mid-call, recorded for audit)
and the post-call structured-data extraction (the source of the
per-shipment value MDR receives) — see the "Tool calls vs. post-call
extraction" section of `CLAUDE.md`.

## Hard rules

Never fabricate information — unknown fields come back `null`. Always
return structured, individually broken-out fields (one common shape for
every call type) plus a summary and transcript, not just prose. Use prior
context to avoid re-asking answered questions, and clearly flag when a
previously-reported value has changed. Voice API calls only the one number
supplied; if unreachable, report `NO_ANSWER` and stop. MDR decides what
happens next in every case.

## Response formats (confirmed by MDR, 2026-10-06)

- `eta`, `pickup_completed_at` and `delivery_completed_at`:
  `YYYY-MM-DD HH:MM:SS` (24-hour), UTC. Relative answers ("in 2 hours") are
  added to the call time; "5 PM" / "tomorrow 3 PM" become full timestamps;
  vague answers are `null`. "N hours late" / "same as before" are measured
  from the shipment's `estimated_delivery_date` + `delivery_appointment`
  (for `PICKUP_TODAY`: from `pickup_date` + its time); a
  bare clock time uses the scheduled date; without a scheduled date the call
  time is the reference (a past scheduled date is ignored). A spoken clock
  time is taken as UTC (no
  timezone conversion).
- `driver: {name, phone, email}` — phone always with a country code, `+1`
  assumed when none is given.
- `driver_confirmed`: `true` = driver contact info is up to date, `false` =
  it isn't, `null` = no driver assigned / not asked.
- A field that was never asked about or stated is `null`, never `false`.

## Tone, company name, greeting (2026-10-09, MDR/client feedback)

- Questions, order and fields are unchanged — only the delivery is softer
  (see "Driver scripts with human touch"): warm, unhurried, never pressuring.
- `calling_from` (top-level request field) is the company name spoken in the
  introduction and whenever the caller asks who is calling / who the shipment
  is for. The word "broker" is never used.
- The contact is greeted by first name (`contact.name`); "I'm not <name>" is
  handled gracefully (ask if they can still help).
- Closing: "Thanks for the update. Drive safe. Goodbye." (drivers).
- `recording_url` is a public link (`/recordings/<call_id>?key=…`, `&download=1`).
- For `PICKUP_TODAY` the ETA is measured against the scheduled pickup
  (`pickup_date`, sent as `YYYY-MM-DD HH:MM:SS`), not the delivery schedule.
