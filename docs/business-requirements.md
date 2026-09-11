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
Webhook = Voice Team calls MDR (`POST https://api.mydrayrate.com/api/v1/agent3/voice/webhook`).

## What MDR sends per call

One contact (type: DRIVER / DISPATCHER / SECONDARY_DISPATCHER /
CARRIER_MAIN / AFTER_HOURS), one shipment's details, a call type, an
explicit `questions[]` list of what it wants asked this call, and
`previous_summary`/`open_issue` — prior context to avoid starting from
zero every call.

## Call types

- **OUT_FOR_DELIVERY** — highest-priority default queue. Location, ETA,
  delay, delivery status, any issue.
- **PICKUP_TODAY** — ask FIRST whether pickup already happened (MDR may
  still trigger this call type after pickup, since TAI can lag). If yes:
  completion time, issues, current movement — do not ask ETA to pickup. If
  no: driver assigned?, ETA to pickup, appointment confirmed?, any issue?
- **DISPATCHED** — pickup within the next 5 working days. Driver/equipment
  assigned?, pickup date/appointment still correct?, any issue?
- **IN_TRANSIT** — location, ETA, delay, and if delayed, whether it's
  traffic/weather/mechanical/other (one `issue_type` value, not several
  booleans).

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
signals — the `flagHumanEscalation` tool (mid-call, immediate) and the
post-call structured-data extraction (a backstop) — see the "Tool calls
vs. post-call extraction" section of `CLAUDE.md`.

## Hard rules

Never fabricate information — unknown fields come back `null`. Always
return structured, individually broken-out fields (one common shape for
every call type) plus a summary and transcript, not just prose. Use prior
context to avoid re-asking answered questions, and clearly flag when a
previously-reported value has changed. Voice API calls only the one number
supplied; if unreachable, report `NO_ANSWER` and stop. MDR decides what
happens next in every case.
