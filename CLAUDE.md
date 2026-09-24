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
   `src/assistant/tools.ts` if a special-case outcome comes up. The fixed
   opening (`FIRST_MESSAGE`) already includes asking permission to
   continue ("...May I ask you a few questions about the shipment?") —
   don't rely on a system-prompt instruction like "then continue in the
   same turn" to add scripted follow-up content after the static first
   message. A voice model is only invoked again once the CALLER says
   something; there is no second "assistant turn" to generate that content
   into if they stay silent. Confirmed empirically 2026-09-23
   (TEST-INTRO-001): an LLM-instruction-based version of this fix did
   nothing, the model just waited silently exactly like before. Bake
   guaranteed-to-be-spoken content into the static message itself instead.
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
exists. `MDR_API_BASE_URL`/`MDR_API_AUTH_TOKEN` are now live, confirmed
directly by the MDR team 2026-09-16 (`https://staging.mydrayrate.com` +
`/api/voice/check-call-completed`, endpoint path hardcoded as a constant in
`src/mdr/api.ts`; Bearer token auth). Both local `.env` and the staging
server's `.env` have the real values — this is no longer a placeholder, and
`CALL_COMPLETED`/etc. events now actually reach MDR's real system.

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
  `control_url` is Vapi's Live Call Control URL for this specific call,
  captured once at creation time (`call.monitor.controlUrl`) — used by
  `src/vapi/callControl.ts` to inject a message/hangup mid-call server-side
  (see "Wrong number vs. wrong contact" below). Per-call, not reusable
  across calls.
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

## CALL_DROPPED vs CALL_HANG

Added 2026-09-24 per MDR's request — splits what used to be one
`CALL_DROPPED` bucket into two event types, confirmed with the user:

- **`CALL_DROPPED`** — Vapi explicitly told us the connection itself
  failed (currently only `phone-call-provider-closed-websocket` in
  `ENDED_REASON_MAP`, `src/server/callOutcome.ts`). A genuine technical
  failure, not an inference.
- **`CALL_HANG`** — everything else that used to be `CALL_DROPPED`:
  `silence-timed-out` (we gave up waiting), an empty transcript (customer
  never spoke, then disconnected), and an abrupt mid-call
  `customer-ended-call` cutoff with `call_ended_abruptly: true`. Same
  payload shape as `CALL_DROPPED` (`partial_result`/`call_summary`) —
  `buildWebhookEvent` in `webhookHandlers.ts` handles both with the same
  case block, only `event_type` differs.

**Known, accepted limitation:** Vapi gives the identical `endedReason`
string (`"customer-ended-call"`) whether a call ended normally, the line
technically dropped mid-conversation, or the customer hung up on purpose
— there is no reliable signal to tell "technical" apart from
"intentional" once conversation had already started. The default for
that ambiguous case is `CALL_HANG`; `CALL_DROPPED` is reserved for
endedReasons Vapi explicitly attributes to a connection/technical
failure. This means some genuine network drops that happen to look like
a clean hangup to Vapi will be misclassified as `CALL_HANG` — a real
accuracy ceiling given what Vapi actually reports, not a bug to chase
further without a better signal from Vapi.

Don't reclassify which `endedReason`/inference maps to which of the two
without the same kind of explicit MDR/user confirmation this split
required — it's not an obvious default either direction.

## Contact update requests

`CONTACT_UPDATE_REQUEST` (added 2026-09-24) is structurally different from
the other four call types — it collects driver/dispatcher contact info,
not a shipment status update — and does NOT share `CommonCallResult`.
This was an explicit, deliberate exception to MDR's own "one common
CALL_COMPLETED response structure" rule (§7A), confirmed directly by the
user 2026-09-24, not a default to reach for casually — don't fold a future
call type into `ContactUpdateResult` or vice versa without the same kind
of explicit confirmation.

- Result shape: `ContactUpdateResult` (`src/mdr/types.ts`) — nested
  `driver`/`dispatcher: {name, phone, email} | null`, plus
  `contacts_confirmed`. `VoiceWebhookEvent`'s `CALL_COMPLETED` variant is
  split in two, discriminated by `call_type`, so `CONTACT_UPDATE_REQUEST`
  can never accidentally carry a `CommonCallResult` or vice versa.
- Extraction: its own Vapi structured-data schema/prompt
  (`src/assistant/contactUpdateResultSchema.ts`), NOT `resultSchema.ts`'s
  `RESULT_SCHEMA`. Applied per-call, not assistant-wide — passed via
  `assistantOverrides.analysisPlan` on call creation
  (`src/vapi/calls.ts`/`mdrCallRequest.ts`) when `call_type ===
  "CONTACT_UPDATE_REQUEST"`. Every other call type is untouched, still
  uses the shared assistant's default `analysisPlan`. Confirmed via
  Vapi's own generated API client that `assistantOverrides.analysisPlan`
  is a real, supported override (2026-09-24) — don't assume other
  assistant-level fields are overridable the same way without checking.
- `contact.type: "CARRIER_REPRESENTATIVE"` (new `CONTACT_TYPES` value) —
  MDR's own example payload sent `"CARRIER REPRESENTATIVE"` with a space,
  which doesn't match this enum's `SCREAMING_SNAKE_CASE` convention and
  will fail validation. MDR needs to send the underscore version; flag
  this if a real request comes in with the space variant and gets
  rejected.
- Capturing an email address over voice is failure-prone. The prompt
  (`CALL_TYPE_QUESTIONS.CONTACT_UPDATE_REQUEST`) instructs the agent to
  have the caller spell it out or confirm a read-back before treating it
  as captured — and the extraction prompt independently reinforces
  leaving `email` null rather than recording an unconfirmed guess.
- `event_type` vocabulary is unchanged — same
  `NO_ANSWER`/`VOICEMAIL`/`BUSY`/`CALL_FAILED`/`CALL_DROPPED`/
  `WRONG_CONTACT`/`CALLBACK_REQUESTED`/`CALL_COMPLETED` set as every other
  call type, confirmed by the user 2026-09-24 (no new event type for
  this).
- MDR's `communication: "voice"` field on the inbound payload is
  deliberately ignored — confirmed by the user as MDR-internal reference
  only, not something to validate or branch on.

## Wrong number vs. wrong contact (both via reportWrongContact)

One tool, two outcomes, distinguished by whether a referral was given —
`reportWrongContact` called with `referred_name`/`referred_phone` both
empty means a flat wrong number (no one to refer), populated means an
actual referral. Both still send MDR's confirmed `WRONG_CONTACT` event
type (there is no separate `WRONG_NUMBER` in the confirmed contract —
don't invent one without asking MDR first; `referred_contact: {name:
null, phone: null}` is how a wrong-number call is distinguished from a
real referral on MDR's side).

The wrong-number case does NOT go through the normal `endCall` tool /
`endCallMessage` flow. MDR gave an exact required closing line, different
from the normal goodbye — but Vapi's `endCallMessage` is one static string
for the whole assistant, always spoken on every `endCall` invocation
regardless of context, so it can't carry two different scripted farewells.
Having the LLM speak the custom line itself and then simply not call
`endCall` (relying on the caller to hang up) was tried and rejected: the
call just sat open — confirmed empirically 2026-09-23 (TEST-WrongNumb-004,
caller had to manually hang up after ~40s). The actual fix, in
`webhookHandlers.ts`'s `applyToolCall`: when `reportWrongContact` fires
with no referral, the server calls `sayAndEndCall()`
(`src/vapi/callControl.ts`) against the call's Live Call Control
`control_url` (captured on `CallRequest.control_url` at call-creation time,
`src/vapi/calls.ts`/`mdrCallRequest.ts`) — this injects MDR's exact
`WRONG_NUMBER_MESSAGE` (`prompt.ts`) via Vapi's `POST {controlUrl}
{type: "say", content, endCallAfterSpoken: true}` and ends the call in one
deterministic step, entirely outside the LLM's turn-generation loop. The
prompt instructs the LLM to say NOTHING itself in this branch — the system
handles both the message and the hangup.

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
- **A silent call that disconnects must never come back `CALL_COMPLETED`.**
  `classifyEventType` (`src/server/callOutcome.ts`) already disambiguates
  Vapi's ambiguous `"customer-ended-call"` endedReason (same string for a
  normal goodbye AND a mid-call drop) via the post-call extraction's
  `call_ended_abruptly` judgment — but that judgment can't be trusted on a
  blank transcript, there's nothing for the LLM to judge from. Confirmed
  empirically 2026-09-23 (TEST-SILENT-005: transcript `""`, extraction
  still reported `CALL_COMPLETED`). Fixed with a deterministic check ahead
  of the LLM signal: if the transcript has zero content, force
  `CALL_DROPPED` regardless of what `call_ended_abruptly` says. Don't
  revert to trusting the extraction alone for this case.
