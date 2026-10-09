# MDR Agent 3 — Engineering Brief

This is the authoritative, kept-in-sync doc for this repo — if something
here disagrees with the code, the code is what shipped; fix this file.

## Architecture in one paragraph

**Reactive, per-request. No dispatch engine, no cron loop, no cadence
logic.** MDR decides who to call, why, and when, and sends one contact +
one call's worth of instructions per HTTP request. This service's entire
job is: accept that request, place the call via Vapi, and — once Vapi's
`end-of-call-report` webhook arrives, minutes later — send the matching
event to MDR's webhook. It never decides the next contact, never retries
on its own, and never maintains its own cross-call history store: MDR
supplies `previous_summary`/`open_issue` (plus a `questions[]` list of
what it specifically wants answered) per shipment on every request
instead. **Do not add a scheduler/dispatcher back in** — there is nothing
left for this service to decide.

**CHANGED 2026-09-28 — multiple shipments per call.** MDR used to send
exactly one shipment per request; it now sends `shipments[]` (an array,
sometimes still length 1), so one phone call can cover several shipments
for the same contact in one conversation. `call_type` is still sent
(currently always `"SHIPMENT_GROUP"`) but is explicitly MDR-internal and
"may change" — it is stored/echoed back but never validated or branched
on. See "Multi-shipment calls" below for what this changed.

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
(`{event_type, mdr_call_id, voice_call_id}`), `CALL_DROPPED`/`CALL_HANG`
carry a `shipments[]` array of partial per-shipment results,
`CALLBACK_REQUESTED` carries `callback_after_minutes`, `WRONG_CONTACT`
carries `referred_contact`, and `CALL_COMPLETED` carries a `shipments[]`
array of full per-shipment results (one entry per shipment MDR sent on the
request — see "Multi-shipment calls" below). See `src/mdr/types.ts`'s
`VoiceWebhookEvent` discriminated union — don't collapse these back into
one shape with a status field, that's the old (wrong) design. The whole
event (`event_type`, `mdr_call_id`, `voice_call_id`) is still call-level,
not per-shipment — confirmed by the user 2026-09-28.

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

In-call Vapi tools (`src/assistant/tools.ts`) exist ONLY for discrete,
call-level, flow-altering outcomes (wrong contact, callback requested,
email requested, human escalation) — never for data fields, and never
scoped to one shipment (tools.ts's hard rule: never accept an internal ID,
like a shipment_id, as an LLM-supplied tool parameter — the LLM can't be
trusted to get it right). Every field in each shipment's result object
(`src/mdr/types.ts`'s `CommonCallResult`, one per shipment) comes from
Vapi's post-call structured-data extraction (`src/assistant/resultSchema.ts`),
evaluated once per call against the full transcript, returning a
`shipments[]` array — one entry per shipment discussed, attributed by
`shipment_id` — with an explicit "null if unconfirmed, never infer, never
blend across shipments" instruction. If you're tempted to add a tool
parameter for a data value, don't — see the "Tool usage rules" section of
`prompt.ts` for why that breaks the never-fabricate requirement.

**CHANGED 2026-09-28 — `human_escalation_required`/`escalation_reason` are
now sourced from the extraction pass ONLY**, not OR'd with the mid-call
tool flag the way the old single-shipment code did. The `flagHumanEscalation`
tool is call-level and can't say which shipment it's about, so OR'ing it
into every shipment's result would falsely mark every shipment on a call
as escalated when only one actually had an issue. `tool_flags.human_escalation_required`
is still recorded on `CallRequest` for internal visibility/audit, just not
merged into the MDR-facing per-shipment result. See
`buildCommonResult` in `webhookHandlers.ts`. The exact escalation trigger
list is confirmed by MDR (see `docs/business-requirements.md`) and
duplicated in both `prompt.ts` and `resultSchema.ts`'s extraction prompt —
keep those two lists in sync if MDR ever revises it.

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
  payload shape as `CALL_DROPPED` (`shipments[]`/`call_summary`) —
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

## Multi-shipment calls (SHIPMENT_GROUP)

CHANGED 2026-09-28, confirmed directly by the user. MDR moved from sending
one shipment per call request to `shipments[]` (an array, sometimes still
length 1) — one phone call can now cover several shipments for the same
contact, worked through one at a time. This retired the old
`CONTACT_UPDATE_REQUEST` call type (see below) and the old per-shipment
`call_type` question-set selection (see below) — both folded into the
general shape.

- **Inbound**: `mdr/types.ts`'s `CallRequestPayload.shipments: ShipmentInput[]`
  — each entry carries its own `status` (free text), `questions[]`,
  `previous_summary`, `open_issue`. These used to be call-level fields;
  they're per-shipment now. `CallRequest.shipments` (the Mongo field) is
  `Schema.Types.Mixed[]`, permissive on purpose — same philosophy as the
  old singular `shipment` field, don't lock it to a strict sub-schema.
- **Question-set selection moved from `call_type` to each shipment's
  `status`.** `call_type` (currently always `"SHIPMENT_GROUP"`) is
  explicitly MDR-internal and "may change" per MDR — it's stored/echoed
  back but never validated or branched on. Instead,
  `src/server/callVariables.ts`'s `resolveStatusKey` normalizes each
  shipment's `status` (uppercase, non-alphanumerics → underscore) and
  matches it directly against `prompt.ts`'s `STATUS_QUESTIONS` keys
  (renamed from `CALL_TYPE_QUESTIONS`) — e.g. `"OUT_FOR_DELIVERY"` matches
  exactly, and `"Out for Delivery"` normalizes to the same key. UPDATED
  2026-09-28: MDR is moving to sending `status` as this exact
  uppercase-with-underscore value (user is informing MDR); the old
  substring keyword matching (`STATUS_KEYWORD_MAP`) is kept only as a
  secondary fallback for wording that doesn't normalize cleanly. Falls
  back to `DEFAULT_STATUS_QUESTIONS` with a console warning if nothing
  matches either way. Question CONTENT was also updated 2026-09-28 with
  MDR's revised (shorter) lists for OUT_FOR_DELIVERY/PICKUP_TODAY/
  DISPATCHED/IN_TRANSIT — a couple of previously-confirmed behavioral
  nuances not restated in MDR's new lists (PICKUP_TODAY's "ask first if
  already picked up" branch, IN_TRANSIT's issue_type categorization) were
  deliberately RETAINED rather than dropped; flag to MDR if they intend
  those gone. `STATUS_QUESTIONS` also gained a `CONTACT_UPDATE_REQUEST`
  key (selected the same way, when a shipment's `status` IS
  `"CONTACT_UPDATE_REQUEST"`) — see the contact-detail bullet below.
- **Prompt**: `prompt.ts`'s system prompt now has a "Shipments to cover on
  this call" section built from `{{shipments_block}}`
  (`callVariables.ts`) — one rendered block per shipment (its ID, previous
  summary/open issue, MDR's specific questions, default status
  questions). The model is instructed to work through shipments ONE AT A
  TIME, in order, explicitly stating the shipment ID when switching to a
  new one, and never blending answers across shipments. Validated
  empirically 2026-09-28 (throwaway transient-assistant test call, 3 fake
  shipments discussed back-to-back with near-identical phrasing) that this
  works reliably — see chat history for the raw extraction result.
- **Extraction**: `resultSchema.ts`'s `RESULT_SCHEMA` now extracts a
  `shipments[]` ARRAY (one entry per shipment, each with its own
  `shipment_id`, all the same fields the old flat result had, plus the
  folded-in contact fields below), instead of one flat object per call.
  `call_ended_abruptly` stays a single top-level field (whole-call signal,
  not per-shipment).
- **Outbound**: `VoiceWebhookEvent`'s `CALL_COMPLETED`/`CALL_DROPPED`/
  `CALL_HANG` variants all carry `shipments[]` now (see "Request
  lifecycle" above) — `webhookHandlers.ts`'s `buildShipmentResults` builds
  one entry per shipment MDR sent on the ORIGINAL inbound request (not per
  extraction entry) — a shipment the call never reached still gets an
  entry (`call_summary: "Not discussed on this call.", confidence_score:
  0`, everything else null) rather than silently vanishing from the
  response. Matching between inbound shipments and extracted results is by
  `shipment_id`.
- **`status` in the response is a pure passthrough**, echoing exactly what
  MDR sent on the matching inbound shipment — confirmed by the user
  2026-09-28 as MDR-internal bookkeeping only, never computed, mapped, or
  validated.
- **Contact-detail collection (formerly `CONTACT_UPDATE_REQUEST`) is now
  just part of the common result.** That call type no longer exists
  separately — `src/assistant/contactUpdateResultSchema.ts` is deleted,
  and its fields (`driver`/`dispatcher: {name, phone, email} | null`,
  `contacts_confirmed`) were folded directly into `CommonCallResult` as
  optional/nullable additions, available on ANY shipment's result. MDR
  signals a shipment needs contact info the same way it asks anything
  else: via that shipment's `questions[]` (e.g. "Can you confirm the
  driver information?"). The email/phone spell-out-and-read-back
  discipline that used to be `CONTACT_UPDATE_REQUEST`-only prompt content
  is now a general "Capturing contact details" section in `prompt.ts`,
  applying whenever any shipment's questions ask for it.
  `assistantOverrides.analysisPlan`'s per-call-type override (in
  `calls.ts`/`mdrCallRequest.ts`) is gone too — every call now uses the
  one shared `analysisPlan`.
- `contact.type: "CARRIER_REPRESENTATIVE"` (a `CONTACT_TYPES` value, kept)
  — MDR's own example payload once sent `"CARRIER REPRESENTATIVE"` with a
  space, which doesn't match this enum's `SCREAMING_SNAKE_CASE` convention
  and will fail validation. MDR needs to send the underscore version; flag
  this if a real request comes in with the space variant and gets
  rejected. UPDATED 2026-10-06: it is now rejected with an immediate `400`
  that lists the accepted values (it used to hang, see "MDR multi-shipment
  feedback changes").
- MDR's `communication: "voice"` field on the inbound payload is
  deliberately ignored — confirmed by the user as MDR-internal reference
  only, not something to validate or branch on.
- **Contact-detail question content restored 2026-09-28, then scoped back
  to status-only the same day.** Initially the actual driver/dispatcher
  name+phone+email question CONTENT (not just the read-back behavior) was
  dropped entirely when `CONTACT_UPDATE_REQUEST` was retired — a real gap,
  caught via testing. First fix added TWO trigger paths (status-driven AND
  a keyword match on a differently-statused shipment's own `questions[]`,
  e.g. a `"Dispatched"` shipment asking "Can you confirm the driver
  information?" auto-expanding to the full checklist) — but the user
  explicitly rejected the keyword path once they saw it fire on a
  `DISPATCHED` shipment in a real test call: **`CONTACT_UPDATE_REQUEST`
  must stay fully separate, never auto-blended into another status.** The
  keyword path (`needsContactDetailQuestions`/`CONTACT_DETAIL_KEYWORDS` in
  `callVariables.ts`) was removed. Current state: `prompt.ts`'s
  `CONTACT_DETAIL_QUESTIONS` is selected ONLY via
  `STATUS_QUESTIONS.CONTACT_UPDATE_REQUEST`, when a shipment's `status` IS
  literally `"CONTACT_UPDATE_REQUEST"` — a `DISPATCHED` (or any other
  status) shipment whose own questions mention driver info now just gets
  asked that literal question, nothing auto-expanded. Don't reintroduce
  the keyword path without the same kind of explicit confirmation this
  reversal required.
- **Not yet confirmed by MDR**: the exact `shipments[]` shape for a
  partial `CALL_DROPPED`/`CALL_HANG` (no worked example exists for the
  multi-shipment case) — `webhookHandlers.ts` mirrors `CALL_COMPLETED`'s
  per-shipment shape as the most consistent assumption. See
  `docs/requirements-tracker.md`.
- **Structured-data extraction reliability — under active investigation,
  2026-09-28.** Two different real multi-shipment test calls on the SAME
  assistant config showed the post-call extraction failing in two
  different ways: one returned invented field names instead of ours
  (`delivery_eta` instead of `eta`, etc. — data captured but silently
  lost since `webhookHandlers.ts` reads by exact name), another returned
  NO `structuredData` at all (`analysis` had only `summary`/
  `successEvaluation`). First fix attempted: flattened the nested
  `driver`/`dispatcher` objects in `resultSchema.ts` into flat
  `driver_name`/`driver_phone`/`driver_email`/`dispatcher_*` fields (see
  that file's header comment) — nested objects are a known LLM
  structured-output reliability risk, and were the only nesting left in
  an otherwise-flat 27-field-per-shipment schema. `webhookHandlers.ts`'s
  `contactInfoFromFlatFields` reconstructs the nested `ContactInfo` shape
  for the OUTBOUND MDR contract, which is unchanged. **Not yet verified
  whether this fixes the underlying reliability issue** — retest with
  real multi-shipment calls before trusting this. If still unreliable,
  the next step under consideration is Vapi's newer Structured Outputs
  API, which their own docs recommend over `analysisPlan` for this kind
  of extraction — not yet investigated in depth.

  **Retest 2026-09-28 (after flattening): field names/structure held up**
  (no more invented names, no more total dropout) — but surfaced a THIRD,
  different problem: clear yes/no answers ("Has a driver been assigned?
  Yes.") were coming back `null` in their matching field while the same
  fact was correctly described in that shipment's `call_summary` prose.
  The model understood the conversation, it just wasn't reliably encoding
  clear answers into their structured fields. Also surfaced a genuine
  schema gap: DISPATCHED's "Is the scheduled pickup date still correct?"
  had no matching field at all (this is exactly why real test calls had
  invented an `pickup_date_correct`-style field before — see above).

  **Fix attempted 2026-09-29**: added `scheduled_pickup_date_correct`
  (boolean, nullable) to the schema/`CommonCallResult`/
  `buildCommonResult`, and added an explicit "CRITICAL" block to
  `RESULT_EXTRACTION_PROMPT` — a plain-language question→field mapping
  table (e.g. "Has a driver been assigned?" -> Yes/No ->
  `driver_assigned: true/false`) plus an instruction that a clear answer
  must never be left null just because it's already in `call_summary`.

  **Retest 2026-09-29: total dropout STILL happened** (2 of ~3 same-day
  retests came back with `analysis.structuredData` completely absent from
  the end-of-call-report webhook, confirmed both via the raw Vapi API and
  directly in Mongo — `structured_result: undefined`) — so flattening
  alone did not fix the underlying issue; this is a genuine intermittent
  problem, not solved by further schema tuning.

  **Root cause theory + fix, 2026-09-29**: Vapi's own docs say
  structured-data analysis "typically completes within a few seconds"
  after the call ends, but `end-of-call-report` fires immediately at call
  end — the empty result is consistent with a RACE, our webhook handler
  reading before Vapi's own extraction pass finishes, not an extraction
  failure per se. Investigated migrating to Vapi's newer Structured
  Outputs API (their docs recommend it over `analysisPlan` for
  reliability) but rejected it: its docs are internally contradictory
  about persistence/webhook delivery (one page says results are stored
  and retrievable via `GET /call/{id}`, another explicitly says "NOT
  stored... webhook access only"), with no confirmed webhook payload
  shape — too risky to build the actual fix for a reliability problem on
  top of an unverifiable mechanism.

  Implemented instead: `webhookHandlers.ts`'s `pollForStructuredData` — if
  the webhook's `structuredData` is missing/empty (checked via
  `hasStructuredShipments`), poll `GET /call/{id}` (the SAME well-proven
  endpoint used throughout this project's manual debugging) up to 4 times,
  3s apart, before giving up. Since this can add ~12s of latency in the
  worst case, `index.ts`'s `end-of-call-report` case was changed to ACK
  Vapi immediately (200) and run `handleEndOfCallReport` in the
  background instead of awaiting it — avoids risking Vapi's own webhook
  delivery timing out and retrying while we poll. The `mdr_pushed_at`
  idempotency guard already made a genuine Vapi retry safe regardless.
  Retested 2026-09-29 with 2-3-shipment calls: 7+ consecutive clean
  `CALL_COMPLETED` results, no dropout — but the retry-poll itself never
  actually needed to fire in any of them (structuredData was present on
  the first webhook every time), so this only ruled OUT the race-condition
  theory for those calls, it didn't prove the poll mechanism works.

  **New failure mode found 2026-09-29 (TEST-MULTISHIP-018, 5 shipments in
  one call): every shipment's `structured_result` entry came back as the
  "not reached" placeholder** (`call_summary: "Not discussed on this
  call.", confidence_score: 0`, everything null) despite the transcript
  showing all 5 shipments fully discussed with clear answers. Confirmed
  via direct `GET /call/{id}` well AFTER call end that
  `analysis.structuredData` was genuinely absent (not a timing issue —
  ruled out `pollForStructuredData` race theory for this case).
  `analysis.summary`/`successEvaluation` (much shorter completions)
  succeeded fine on the same call — points at the structured-data
  completion itself (5 shipments x 27 required fields, much bigger JSON
  output than any earlier 2-3-shipment test) exceeding
  `structuredDataPlan`'s default `timeoutSeconds` and getting dropped.
  Vapi's own docs recommend raising `timeoutSeconds` (no value was ever
  set before this, so it was on whatever Vapi's low default is) when
  extraction times out. **Fix applied**: `create.ts`'s
  `structuredDataPlan` now sets `timeoutSeconds: 30` explicitly. **Not yet
  retested against a real 4-5-shipment call — requires `npm run
  assistant:create` (user-run only) then a new test call before trusting
  this.** If 30s still isn't enough for 5 shipments, consider raising
  further or reconsider whether a single call should realistically cover
  that many shipments at all.

## MDR multi-shipment feedback changes (2026-10-06)

A batch of fixes from MDR's testing of the multi-shipment flow, done one at
a time and each verified on real calls (local server + `npm run
assistant:create`). Where each lives, so the next person doesn't undo it:

- **Single-shipment wording.** With exactly one shipment the agent asks
  questions directly — no "First"/"Second"/"next", no "for a different
  shipment", no shipment ID. `callVariables.ts`'s `shipmentWordingRule`
  fills `{{shipment_wording_rule}}` in `prompt.ts` (it overrides the
  multi-shipment "say the ID once" rule). Because the ID is no longer
  spoken, the extraction pass returns `shipment_id: ""` for that call —
  `webhookHandlers.ts`'s `buildShipmentResults` pairs the lone extracted
  entry with the lone inbound shipment directly instead of reporting it as
  "not reached" (regression found and fixed 2026-10-06). Multi-shipment
  calls still match by `shipment_id`.
- **Never re-ask what was already answered** (general rule in
  `prompt.ts`, plus an inline condition on OUT_FOR_DELIVERY's "Has delivery
  happened yet?", which is asked ONLY if the caller hasn't given an ETA,
  mentioned a delay, or said it was delivered — an inline condition is
  followed far more reliably than the general rule alone). A stated delivery
  ETA with no "already delivered" means `delivery_completed: false`
  (extraction rule, confirmed by the user). Unclear/garbled/partial
  answers are re-asked ONCE, then accepted as unknown; an ETA with only a
  day or something vague ("tomorrow", "soon") gets one "What time would
  that be?". The agent must never call `endCall` mid-question or before
  every shipment is covered (a real multi-shipment call was cut off after
  "Tomorrow" because it called `endCall` in the same turn as a question).
- **Delay cause.** After "yes" to a delay the agent asks "...traffic,
  weather, a mechanical problem, or something else?" for EVERY status
  (general rule). Extraction: `delay_reason` = the caller's words,
  `issue_type` = exactly one of `traffic`/`weather`/`mechanical`/`other`.
  MDR's 09-28 shorter lists had silently dropped this question; it was
  restored. Only the cause is asked, not the duration (`delay_minutes`
  fills only if volunteered).
- **`null` unless actually asked/stated.** The extraction model kept
  filling `delay`, `delivery_completed`/`pickup_completed` with `false`
  for things never discussed; explicit rules in `resultSchema.ts` now
  force `null`. `false` means the caller said no.
- **Contact-type awareness.** `callVariables.ts`'s `describeContact` passes
  who is on the call into the system prompt (`{{contact_context}}`) and the
  extraction prompt (`{{contact_summary_note}}`, so `call_summary` says
  "the dispatcher said the driver..."). `DISPATCHER` and
  `SECONDARY_DISPATCHER` get `DISPATCHER_STATUS_QUESTIONS` (third-person
  "Where is the driver currently?" / "What is the driver's current ETA?" /
  "Is there any delay with the delivery?") for OUT_FOR_DELIVERY and
  IN_TRANSIT; every other contact type (`DRIVER`, `CARRIER_MAIN`,
  `AFTER_HOURS`, `CARRIER_REPRESENTATIVE`) gets the normal wording.
  PICKUP_TODAY/DISPATCHED already speak about "a driver" in the third
  person. **Don't put the contact's NAME in the extraction note** — it was
  copied into `dispatcher_name`, fabricating a captured dispatcher.
- **Timestamps: `YYYY-MM-DD HH:MM:SS`, 24-hour, UTC** for `eta`,
  `pickup_completed_at` and the new `delivery_completed_at`
  (`src/server/timeFormat.ts`). Each call gets `{{call_start_utc}}`
  (`callVariables.ts`) so the extraction can resolve "in 2 hours" (call
  time + 2h), "5 PM" (today), "tomorrow 3 PM", "an hour ago" (past, for
  completed-at fields); vague answers are `null`. **ETA is computed in CODE, not by the extraction model
  (2026-10-08, MDR feedback):** the model only classifies what the caller
  said (`eta_kind`: `explicit` / `late` / `same` / `from_now` /
  `clock_time`, plus `eta_offset_minutes` / `eta_clock_time`; `eta` itself
  only for `explicit`), and `src/server/etaCalc.ts`'s `computeEta` builds
  the timestamp: explicit date+time as stated; "N hours late" = the
  shipment's scheduled delivery (`estimated_delivery_date` +
  `delivery_appointment`, `timeFormat.ts`'s `parseScheduledDelivery`) plus
  the delay, or call time + delay when there is no usable schedule; "same
  as before"/"on time" = the scheduled time (`null` if none); "in N hours"
  = call start + N; a bare clock time ("5 PM") = that time on the scheduled
  DATE, else the call's date. A scheduled date earlier than the call date
  is stale and ignored. "Call time" is Vapi's `startedAt`. This replaced a
  prompt-only version in which the model, even when handed the schedule,
  answered "2 hours late" with call time + 2h. The agent accepts "2 hours
  late"/"same as before" as a complete ETA answer. `normalizeMdrTimestamp`
  re-validates in code — anything not matching the exact format (or not a
  real date) is sent as `null`, never as free text. **Known, accepted
  limitation (user's decision):** a spoken clock time is treated AS UTC
  with no timezone conversion, since the contact's timezone isn't known —
  e.g. a caller in India saying "2 PM" produces `14:00:00` UTC, which can
  even be later than the call itself.
- **`delivery_completed_at`.** When the caller says it's delivered, the
  agent asks once "What date and time was it delivered?" (skipped if
  already given; a vague answer gets one follow-up). Only set when
  `delivery_completed` is true. Delivery times go ONLY in this field — the
  extraction once put one in `pickup_completed_at`; schema descriptions
  and an explicit warning in `resultSchema.ts` guard against that.
- **DISPATCHED / PICKUP_TODAY driver flow** (`prompt.ts`'s
  `DRIVER_ASSIGNED_FOLLOW_UP`, spliced into both lists): "Has a driver been
  assigned?" -> no: continue; yes: "Is the driver contact information
  updated?" -> yes: don't ask name/phone; no: ask the driver's name, then
  phone (read back to confirm, no email). Maps to `driver_assigned`;
  `driver_confirmed` (true = contact info is current, false = it isn't,
  `null` = no driver assigned / not asked); `driver: {name, phone,
  email: null}` (the existing nested shape, no new flat fields).
  PICKUP_TODAY skips "What is the driver's ETA to pickup?" when no driver
  is assigned. Delay wording now matches MDR's lists ("...with the
  shipment?" / "...with the pickup?").
- **Phone numbers carry a country code** (`src/server/phoneFormat.ts`,
  applied to driver and dispatcher phones): 10 digits -> `+1`; an explicit
  `+` keeps its own code; 11-15 digits with no `+` are treated as already
  including a country code; a `+1` number that isn't exactly 11 digits, or
  anything too short/long, becomes `null`. The extraction writes digits
  exactly as spoken and must NOT add `+1` itself (it once turned a
  spoken 91... number into an invalid `+191...`).
- **`POST /mdr/call-requests` robustness** (`mdrCallRequest.ts`). Express 4
  doesn't forward a rejected async handler to the error middleware, so an
  invalid `contact.type` (e.g. `"CARRIER"` or `"CARRIER REPRESENTATIVE"`
  with a space) used to leave the request with NO response — MDR saw a
  timeout. Now: `contact.type` must be an exact `CONTACT_TYPES` value and
  `contact.name`/`contact.phone` are required, else an immediate `400
  {error: "invalid contact", details, allowed_contact_types}`; the handler
  is wrapped so any other failure returns `400` (Mongoose validation) or
  `500` instead of hanging. `CARRIER` stays rejected (user's decision).
- **Response time.** The `RawCapture` write now starts first but overlaps
  the other work (awaited just before every response, never rejects), and
  each successful request logs `[mdrCallRequest] <id> timings ms:
  db_create=… vapi_create_call=… db_save=… total=…`. Measured: our own
  work is small; Vapi's create-call (0.4-1.5s) and network distance
  dominate. The final `save()` is deliberately still awaited before the
  ack (the Vapi call ID must be stored before webhooks arrive).
- **Voice latency / opening.** Per-reply latency on real calls is ~1.4-2.5s
  (model ~0.55-0.7s, `eleven_v3` voice ~0.6-1.0s with spikes to ~2s,
  transcriber/endpointing ~0.1-0.7s). **The voice model stays
  `eleven_v3`** (user's decision — a flash/turbo model would cut ~0.5s but
  changes how the agent sounds). The opening "Hello." script is unchanged
  and works as MDR specified; with `assistant-speaks-first` anything the
  caller says in the first ~1-2s before the agent's "Hello." is ignored
  (switching to `assistant-waits-for-user` was considered, NOT done — it
  would drop the "Hello." script MDR asked for). The introduction was
  shortened to exactly two sentences (saves only ~1s).
- **Closing pause.** Superseded 2026-10-09: the closing now ends with a
  `[short pause]` tag, see "Tone, calling_from, recordings, closing" below.

## Tone, calling_from, recordings, closing (2026-10-09)

MDR/client feedback: the questions stay exactly the same, only the delivery
changes. All of it lives in `src/assistant/prompt.ts` unless noted.

- **Polite tone.** "Tone" section is warm/unhurried; "Phrasing the questions
  politely" gives soft wordings with a lead-in ("Could you tell me where you
  are right now?", "And about when do you expect to get there?", "And are you
  running into any delays or issues at the moment?"; dispatcher versions talk
  about the driver). A bare "Where…/When…/Are…" is avoided — if the voice
  clips a sentence's first word it still makes sense. Each turn is a 1-3 word
  acknowledgement ("Got it.", "Okay.") + the question; the agent must NOT
  echo the caller's answer back ("Okay Valley", "About 2 hours") unless it
  is unsure it heard it. Question lists, order and skip rules are unchanged.
- **`calling_from`** (top-level field of the call request, optional). Stored
  on `CallRequest.calling_from`, exposed to the prompt as `{{calling_from}}`
  (`callVariables.ts`; "our company" when absent). It replaced every
  hardcoded company name (intro, voicemail message, caller Q&A). The word
  "broker" is never spoken; "who is this shipping for?" / "what company are
  you calling on behalf of?" / "where are you calling from?" are all the same
  question and get "I'm Everly, calling on behalf of <calling_from> for a
  quick operational update on your shipment(s)."
- **Caller questions.** Each shipment block carries "Shipment details" (status,
  pickup date, estimated delivery date, delivery appointment, carrier,
  `callVariables.ts`) the agent may share ONLY when asked; anything missing →
  "I don't have that detail in front of me". It admits being an AI when asked.
  After answering a caller's question it asks the pending question again and
  must never call `endCall` in that turn (a real call ended after answering
  "How many shipments?" with a shipment still unasked).
- **Closing.** `END_CALL_MESSAGE` = "Thanks for the update.{{closing_wish}}
  Goodbye. [short pause]"; `closing_wish` is " Drive safe." for `DRIVER`
  contacts, " Have a good day." otherwise (Vapi fills it from
  `variableValues`, like `{{shipment_ids_text}}` in the voicemail message).
  `[short pause]` is an eleven_v3 tag that stops the hang-up cutting off
  "Goodbye." — `[long pause]` was too long.
- **Names/phones.** A garbled driver name ("Same", "M") is re-asked and
  confirmed; the phone is read back digit by digit and a short number gets
  "Is that the full number?"; a number that can't be made E.164 is kept as the
  spoken digits instead of `null` (`contactInfoFromFlatFields`).
- **`recording_url` is public** (`webhookHandlers.ts` `buildPlayableRecordingUrl`
  → `src/server/recordings.ts`): `<PUBLIC_BASE_URL>/recordings/<vapi_call_id>?key=<RECORDINGS_PROXY_SECRET>`,
  plays inline, `&download=1` downloads. The route calls Vapi's
  `/call/{id}/stereo-recording` server-side with the Vapi key (Vapi's own
  recording URL is private). Same approach as Agent-1/2.
- **Latency is the voice, not the model.** Per-turn: model ~0.4-0.8s, but
  `eleven_v3` voice spikes 6-10s on some turns (worse on 2026-10-09) and
  Deepgram occasionally 5-9s. Not fixable in prompt/code; the only real lever
  is a faster voice model, which the user has declined so far.
- **MDR bearer token** (`MDR_API_AUTH_TOKEN`) for staging was replaced on
  2026-10-09 in both the local and staging-server `.env`.

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
- **Multi-shipment `CALL_DROPPED`/`CALL_HANG` `shipments[]` shape is an
  assumption, not confirmed by MDR.** See "Multi-shipment calls" above.
- **Per-shipment `human_escalation_required` relies entirely on the
  post-call extraction pass** (see "Tool calls vs. post-call extraction"
  above) — there's no way to attribute the mid-call `flagHumanEscalation`
  tool to a specific shipment. If real multi-shipment calls show the
  extraction missing an escalation the tool caught, this trade-off needs
  revisiting.
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
- **Closing-line detection (changed 2026-10-09).** The closing line is now
  "Thanks for the update. Drive safe. Goodbye." (drivers) / "Thanks for the
  update. Have a good day. Goodbye." (others), so the old first-sentence
  match is gone. `callOutcome.ts`'s `COMPLETION_SIGNAL` looks for an AI line
  containing "goodbye", "drive safe" or "have a good day" (the final
  "Goodbye." is sometimes cut off by the hang-up). Don't use "Thanks for the
  update" as the signal: the agent says it mid-call as an acknowledgement.
- **A call cut short after the closing line still reads `CALL_COMPLETED`.**
  The completion check is only "closing line present in the transcript",
  not "every shipment's questions were covered".
- **Escalation on an unclear answer.** A garbled but important answer
  (e.g. the driver's location) can set `human_escalation_required: true`
  via MDR's own "cannot confidently understand an important answer" rule.
  Left as MDR's rule.
- **Spoken times are treated as UTC** (see the timestamp bullet above).
- **Manual test pass still pending for:** `IN_TRANSIT`,
  `CONTACT_UPDATE_REQUEST`, `SECONDARY_DISPATCHER` and the non-driver
  contact types, and the PICKUP_TODAY/multi-shipment driver-flow branches
  (see `docs/test-cases.md`).
