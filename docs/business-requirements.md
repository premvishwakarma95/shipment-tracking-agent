# Business Requirements Digest

Source: "MDR Agent 3 – Instructions for Voice API Team" (client PDF). This
is a short digest for onboarding — the PDF itself is the source of truth
for exact wording/examples; `docs/requirements-tracker.md` tracks what's
confirmed vs. still open.

## Responsibility split

MDR decides **who** to call and **why**. Voice API (this service) makes
**one** call per request, conducts the conversation, and reports back a
structured result. Voice API never picks the next contact, never retries
on its own, never auto-dials a referred number, and never self-schedules a
callback — all of that is MDR's decision.

## What MDR sends per call

One contact (type: DRIVER / DISPATCHER / SECONDARY_DISPATCHER /
CARRIER_MAIN / AFTER_HOURS), one shipment's details, a call type, and any
relevant prior interaction history / open items MDR already knows about.

## Call types

- **OUT_FOR_DELIVERY** — highest-priority default queue. Location, ETA,
  delay, delivery status, any issue.
- **PICKUP_TODAY** — driver assigned?, ETA to pickup, appointment
  confirmed?, any issue?
- **DISPATCHED** — pickup within the next ~5 business days. Driver/
  equipment assigned?, pickup date/appointment still correct?, any issue?
- **IN_TRANSIT** — location, ETA, delay + reason (traffic/weather/
  mechanical).

## Hard rules

Never fabricate information — unknown fields come back `null`. Always
return structured, individually broken-out fields plus a summary and
transcript, not just prose. Use prior context to avoid re-asking answered
questions, and clearly flag when a previously-reported value has changed.
Voice API calls only the one number supplied; if unreachable, report
`NO_ANSWER` and stop. MDR decides what happens next in every case.
