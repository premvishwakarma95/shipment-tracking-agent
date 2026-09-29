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

UPDATED 2026-09-29 — these are no longer selected by a request-level
`call_type` (retired along with the old single-shipment format; see
CLAUDE.md's "Multi-shipment calls" section). Each shipment within a
`SHIPMENT_GROUP` request now carries its own `status`, matched against
these same five sets in `src/assistant/prompt.ts`'s `STATUS_QUESTIONS`.
Content below reflects MDR's 2026-09-29 revised wording (`STATUS_QUESTIONS`
is the source of truth — keep this digest in sync with it, not the other
way around):

- **OUT_FOR_DELIVERY** — Where are you now? Current ETA? Any delay? Has
  delivery happened yet?
- **PICKUP_TODAY** — Has a driver been assigned? Driver's ETA to pickup?
  Pickup appointment confirmed? Any delay? (No longer a two-branch
  "ask whether already picked up first" flow — that was removed
  2026-09-29 per explicit confirmation this flat list is correct.)
- **DISPATCHED** — Driver/equipment assigned? Scheduled pickup date still
  correct? Appointment confirmed? Any delay?
- **IN_TRANSIT** — Where are you now? Current ETA? Any delay?
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
