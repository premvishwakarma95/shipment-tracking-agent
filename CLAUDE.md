# MDR Agent 3 — Engineering Brief

This is the authoritative, kept-in-sync doc for this repo — if something
here disagrees with the code, the code is what shipped; fix this file.

## Architecture in one paragraph

**Reactive, per-request. No dispatch engine, no cron loop, no cadence
logic.** MDR decides who to call, why, and when, and sends exactly one
contact + one shipment + call instructions per HTTP request. This service's
entire job is: accept that request, place the call via Vapi, and — once
Vapi's `end-of-call-report` webhook arrives, minutes later — send the
matching event to MDR's webhook. It never decides the next contact, never
retries on its own, and never maintains its own cross-call history store:
MDR supplies `previous_summary`/`open_issue` (plus a `questions[]` list of
what it specifically wants answered) on every request instead.
**Do not add a scheduler/dispatcher back in** — there is nothing left for
this service to decide.

## Request lifecycle

Confirmed by MDR's "MDR Agent 3 – Voice API Integration Guide" — this is a
real contract now, not a placeholder guess (see
`docs/requirements-tracker.md` for what's still open within it).

1. `POST /mdr/call-requests` (`src/server/mdrCallRequest.ts`) — raw-captures
   the payload, validates loosely, creates a `CallRequest`, places the
   outbound call via `src/vapi/calls.ts`, responds `202
   {success: true, mdr_call_id, voice_call_id, status: "QUEUED"}`
   immediately.
2. Vapi calls the contact, runs the conversation per
   `src/assistant/prompt.ts`, calling one of the 4 tools in
   `src/assistant/tools.ts` if a special-case outcome comes up.
3. `POST /vapi/tool-calls` (`src/server/index.ts` → `webhookHandlers.ts`)
   receives both Vapi's `tool-calls` events (writes `tool_flags` on the
   `CallRequest`) and its `end-of-call-report` (`classifyEventType` picks
   one of MDR's confirmed `event_type` values, `buildWebhookEvent` shapes
   the matching payload, `src/mdr/api.ts` sends it to MDR's webhook).

**Important: the MDR webhook is event-shaped, not one universal envelope.**
`NO_ANSWER`/`VOICEMAIL`/`BUSY`/`CALL_FAILED` are minimal
(`{event_type, mdr_call_id, voice_call_id}`), `CALL_DROPPED` carries a
`partial_result`, `CALLBACK_REQUESTED` carries `callback_after_minutes`,
`WRONG_CONTACT` carries `referred_contact`, and only `CALL_COMPLETED`
carries the full common `result` object. See `src/mdr/types.ts`'s
`VoiceWebhookEvent` discriminated union — don't collapse these back into
one shape with a status field, that's the old (wrong) design.

See `docs/call-flow.md` for the diagram.

## Env vars

See `.env.example` — every non-obvious one has a comment explaining why it
exists. `MDR_API_BASE_URL`/`MDR_API_AUTH_TOKEN` are deliberately still
pointed at a placeholder even though the real base URL and webhook path are
now confirmed (`https://api.mydrayrate.com` + `/api/v1/agent3/voice/webhook`,
hardcoded as a constant in `src/mdr/api.ts`) — don't flip them to the real
value without checking with the user first; test-case coverage is still in
progress and pushing test events to MDR's real system would be wrong. Auth
scheme for that webhook is still unconfirmed — `src/mdr/client.ts` sends no
auth header at all unless `MDR_API_AUTH_TOKEN` is set.

## Data model

Only two Mongo collections:

- `CallRequest` (`src/db/models/CallRequest.ts`) — intentionally thin. It
  exists only to bridge the gap between "we told Vapi to dial" and "Vapi's
  webhooks tell us what happened." It is NOT a history store — don't add
  cross-call queries against it the way the reference project's
  `callMemory.ts` did; MDR already sends `previous_summary`/`open_issue`
  per request. `lifecycle_status` (internal bookkeeping: have we heard back
  from Vapi yet?) and `event_type` (MDR-facing outcome: what happened on
  the call?) are deliberately separate fields — don't collapse them.
- `RawCapture` — unconditional, unparsed capture of every inbound payload
  (both MDR call requests and Vapi webhooks), written before any parsing.
  Audit safety net for payload shapes that aren't fully locked down yet.
  Never cleared by `npm run db:reset`.

## Tool calls vs. post-call extraction

In-call Vapi tools (`src/assistant/tools.ts`) exist ONLY for discrete
flow-altering outcomes (wrong contact, callback requested, email requested,
human escalation) — never for data fields. Every field in the common
`result` object (`src/mdr/types.ts`'s `CommonCallResult`) comes from Vapi's
post-call structured-data extraction (`src/assistant/resultSchema.ts`),
evaluated once against the full transcript with an explicit "null if
unconfirmed, never infer" instruction. If you're tempted to add a tool
parameter for a data value, don't — see the "Tool usage rules" section of
`prompt.ts` for why that breaks the never-fabricate requirement.

`human_escalation_required`/`escalation_reason` are the one field pair
checked from BOTH sources (`buildCommonResult` in `webhookHandlers.ts` ORs
the in-call tool flag with the post-call extraction) — the tool is for
escalating the instant the LLM recognizes one of MDR's defined trigger
conditions mid-call; the extraction pass is a backstop in case it didn't.
The exact trigger list is confirmed by MDR (see `docs/business-requirements.md`)
and duplicated in both `prompt.ts` and `resultSchema.ts`'s extraction
prompt — keep those two lists in sync if MDR ever revises it.

## Known gaps / don't repeat these

- **`EMAIL_REQUESTED` has no confirmed MDR event_type.** The confirmed
  integration guide's webhook event list doesn't include it (only
  NO_ANSWER/VOICEMAIL/BUSY/CALL_FAILED/CALL_DROPPED/CALLBACK_REQUESTED/
  WRONG_CONTACT/CALL_COMPLETED). We still capture it via
  `reportEmailRequested`/`tool_flags.email_requested` for visibility, but
  it currently isn't sent to MDR as its own event. Don't invent an event
  type for it — ask MDR first (`docs/requirements-tracker.md`).
- **`VOICEMAIL`/`BUSY`/`CALL_FAILED` payload shape is assumed, not shown.**
  The integration guide only gives a worked example for `NO_ANSWER`
  (minimal `{event_type, mdr_call_id, voice_call_id}`) and groups the other
  three alongside it in prose. We send the same minimal shape for all four.
  If MDR says otherwise, only `buildWebhookEvent` in `webhookHandlers.ts`
  needs to change.
- **`next_action` in `CommonCallResult` is unconfirmed.** It's named in the
  guide's prose (§7) but absent from the one worked `CALL_COMPLETED`
  example. Kept for now; drop it if MDR says it's not wanted.
- There is no retry queue for a failed push to MDR
  (`mdr.sendVoiceWebhookEvent` failing leaves `mdr_pushed_at` null for
  manual reconciliation). Don't add one speculatively — get a retry policy
  from MDR first (`docs/requirements-tracker.md`).
