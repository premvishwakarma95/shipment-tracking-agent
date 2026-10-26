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
shipments for that contact). Each shipment may also carry `pickup_location`, `delivery_location`, `driver {name, phone}` and the scheduled dates. Each shipment carries its own `status`,
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

Calling patterns (MDR "Status-Based Calling Scripts", 2026-10-14 — same
questions, different order/skips; per status and per contact type, driver vs
dispatcher; `src/assistant/prompt.ts` is the source of truth). Every call
first names the shipment ID, route and the relevant scheduled time.

- **OUT_FOR_DELIVERY** — "Already delivered, or still on track for <time>?"
  Delivered -> date/time only. On track/on schedule -> done (answers ETA and
  delay). A time or distance -> that is the ETA, then the delay question.
  Late -> new ETA + cause. Unsure -> location, then ETA.
- **PICKUP_TODAY** — Confirm the driver on record (or "Has a driver been
  assigned?"; if not up to date, collect name and phone). Then ONE on-schedule
  question instead of "driver's ETA" (on schedule answers ETA + delay), the
  pickup appointment question (always asked), and the delay question only if
  still needed. No driver: ask whether one will be available in time.
- **DISPATCHED** — Driver on record / assigned (no driver: record it and when
  one is expected, no contact details). Equipment assigned (if not: what is
  pending, does it affect pickup). One combined "pickup still correct and
  appointment confirmed?" (changed date -> revised date/time; unconfirmed ->
  when it will be). Any delay (reason + revised pickup time).
- **IN_TRANSIT** — "On track for <day + time>?" On schedule -> accept, ask
  location, no ETA/delay questions. Late -> new arrival time + cause. Several
  days out -> confirm the schedule only. No scheduled time -> ask the
  expected date/approximate arrival (stored as an estimate). Delay cause is a
  single `issue_type`.
- **Dispatcher contacts** (`DISPATCHER`, `SECONDARY_DISPATCHER`) are asked
  about the driver in the third person. Every other contact type gets the
  driver wording. `call_summary` names the actual person on the call.
- **CONTACT_UPDATE_REQUEST** — contact accuracy only (no ETA/location/delay).
  Confirm the driver on record and the dispatcher; ask name, phone (read back,
  10 digits, country code added) and optional email only for what is wrong or
  missing; confirmed contacts end the call. If the driver can't give the
  dispatcher's details they are flagged for verification (`open_issue`).

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

## Previous summary and open issue (2026-10-12)

- If a shipment has `previous_summary` / `open_issue`, the agent does not ask
  those questions cold: it states the earlier information and asks whether it
  is still correct, and reconfirms an open issue. Changed answers are taken as
  the new answer; anything not covered is asked normally. Shipments without
  them are asked from scratch.
- A bare clock time ("2:30 PM") is stored exactly as spoken (24-hour) on the
  scheduled date, or the call's date — include the date in `previous_summary`
  when it matters.

## Silence mid-call (2026-10-14, MDR decision)

If the caller goes silent and the agent gives up with the normal closing line,
the event stays `CALL_COMPLETED`; `call_summary` states that the caller stopped
responding and which questions went unanswered.

## Carrier representative script (2026-10-23)

Only for `contact.type: CARRIER_REPRESENTATIVE`: introduction on behalf of
`calling_from` with the number of shipments and the earlier contact attempts,
then an options menu (give updates now / change driver or dispatcher contacts /
reply through the emailed update link, which can be resent). Updates are taken
shipment by shipment (ID, route, current status, open question; delivered ->
date and time, late -> cause and new arrival, plus MDR's status-wise
questions for what is still missing). A changed driver or dispatcher is saved
per shipment in `driver` / `dispatcher` (name, phone, email). If the rep asks for
the email to be sent or resent (or gives a new address) the agent says it was
resent and the result carries `email_requested: true` (+ `requested_email`);
MDR sends the emails and the event type stays `CALL_COMPLETED`. Closing: "Thanks
so much for your help! We really appreciate you taking the time to get these
shipments updated. Have a great day!" The calling window is MDR's, not ours.

Update 2026-10-26: `email_requested` and `requested_email` are always present in
each shipment result (`null` when no email was requested), like `driver` and
`dispatcher` (null when nothing was collected). On a CONTACT_UPDATE_REQUEST
shipment the carrier representative is asked only about the driver and dispatcher
on that shipment (never their own details). The agent confirms the final spelling
of a new email address before saying it has been resent.

Update 2026-10-26 (later): when the request carries `contact.email`, the options
menu says "We've also sent an email to <address> with an update link"; otherwise
the generic wording. A resend request always sets `email_requested` (+ the address
on record or the new one), including if the agent forgot to record it mid-call.
