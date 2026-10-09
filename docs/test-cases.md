# Manual Test Cases

Status legend: `[ ]` not run · `[x]` pass · `[!]` fail, see notes.

Setup: run `npm run server:dev`, tunnel it (e.g. `ngrok http 3000`), set
`PUBLIC_BASE_URL` to the tunnel URL, run `npm run assistant:create` once.
Send test payloads with `curl -X POST $PUBLIC_BASE_URL/mdr/call-requests -H "x-api-key: $MDR_WEBHOOK_SHARED_SECRET" -H "Content-Type: application/json" -d @payload.json`.
Watch the server console — `src/mdr/api.ts` logs the full outgoing webhook
event and MDR's response (or failure) for every call, since
`MDR_API_BASE_URL` is still pointed at a placeholder (see
`docs/requirements-tracker.md`).

## Core call types

- [x] **TC-01 OUT_FOR_DELIVERY, no delay** — driver confirms location/ETA,
  no issues. Expect `event_type: CALL_COMPLETED`, `result.delay: false`,
  `result.issue_type: null`. Re-run 2026-09-11 (TEST-001) against the new
  schema — passed, transcript/recording/`event_type: CALL_COMPLETED` all
  correct.
- [x] **TC-02 OUT_FOR_DELIVERY, delay** — driver reports traffic delay.
  Expect `result.delay: true`, `result.delay_minutes` populated,
  `result.issue_type: "TRAFFIC"` (or similar). Run 2026-09-11 (TEST-002,
  combined with TC-07): driver reported "around 1 hour delay" / "acute
  traffic" — transcript confirms the assistant asked the right follow-ups.
  Still worth expanding `structured_result` in Compass to double check
  `delay_minutes`/`issue_type` extracted as expected, not just that the
  conversation flowed correctly.
- [x] **TC-03 PICKUP_TODAY, not yet picked up, driver assigned** — answer
  "no" to "has it been picked up", then confirm driver name/ETA/appointment.
  Expect `result.driver_assigned: true`, `result.eta` populated,
  `result.pickup_completed: false`. Passed 2026-09-14 (TEST-003):
  `pickup_completed: false`, `driver_assigned: true`,
  `appointment_status: "CONFIRMED"` all correct. `eta: null` despite the
  dispatcher attempting to give one — correct behavior, not a bug: the
  transcript shows garbled STT on that answer, so the never-fabricate rule
  correctly refused to guess a value from noise.
- [x] **TC-04 PICKUP_TODAY, already picked up** — answer "yes" to "has it
  been picked up". Expect `result.pickup_completed: true`,
  `result.pickup_completed_at` populated if given, and confirm (via
  transcript) the assistant does NOT ask for a driver ETA to pickup. Passed
  2026-09-14 (TEST-004): `pickup_completed: true` correct, transcript
  confirms no driver-ETA-to-pickup question was asked after "yes."
  `pickup_completed_at: null` is correct (caller's answer was cut off
  before giving a time). Found & fixed a real bug from this run: `summary`
  came back `null` and `confidence_score` came back `null` on BOTH TC-03
  and TC-04 — these are the AI's own assessment of the call, not
  caller-stated facts, so they should never be null. Root cause: the
  extraction prompt's "null if unconfirmed" rule was being over-applied to
  them. Fixed in `resultSchema.ts` (explicit exception in the prompt, both
  fields now non-nullable + `required` in the JSON schema) and
  `webhookHandlers.ts` (defensive fallback + warning if still missing).
  **Re-run TC-01–TC-04 to confirm the fix actually populates both fields
  now** — not yet re-verified after the fix.
- [x] **TC-05 DISPATCHED** — confirm driver/equipment/pickup date/
  appointment as a set of yes/no answers. First run 2026-09-14 (TEST-005)
  found the invented-field-name bug and the question-batching bug (see
  below). Re-run 2026-09-14 (TEST-055) after both fixes — passed:
  `driver_assigned: true`, `equipment_assigned: true`,
  `appointment_status: "CONFIRMED"` (correctly folding both "pickup date
  still correct" and "appointment confirmed" into one field, per MDR's
  one-common-shape rule), `confidence_score`/`summary` populated, zero
  invented fields. Transcript confirms one question per turn now.
- [x] **TC-06 IN_TRANSIT, mechanical issue** — driver reports a mechanical
  problem. First run 2026-09-14 (TEST-006) hit the same invented-field bug
  as TC-05 (`issue_type` missing, ad hoc fields instead). Re-run 2026-09-14
  (TEST-066) after the fix — passed: all 18 `structured_result` keys match
  the schema exactly, `issue_type: "mechanical problem"`,
  `current_location`/`eta`/`delay`/`delay_reason` all correct, one question
  per turn (even recovered gracefully from a cut-off answer). Driver said a
  bare "mechanical problem" (not qualified as minor) so
  `human_escalation_required: true` is the correct, defensible call here —
  **TC-16b (should NOT escalate) still needs a clearly-minor answer** (e.g.
  "just a check engine light, still driving fine") to properly test the
  negative case; this run doesn't cover that.

**Bug found across TC-05/TC-06, fixed:** `resultSchema.ts` didn't set
`additionalProperties: false` and only 2 of 18 fields were `required` — so
the extraction pass was free to invent its own field names (loosely copied
from conversation/prompt wording) instead of using ours, and to drop real
schema fields it didn't feel like filling. Only `confidence_score`/`summary`
(the two that WERE required) came through reliably every time. Fixed:
`additionalProperties: false` + all 18 fields now `required` (nullable
fields stay nullable, just always *present*). Verified live on the
assistant via the Vapi API after pushing — confirmed
`additionalProperties: false` and the full required list before re-testing.
**TC-01 through TC-06 all need re-running** to confirm this fix holds
across every call type, not just re-verify DISPATCHED/IN_TRANSIT.

## Previous-context handling

- [x] **TC-07 reconfirmation phrasing** — send a request with
  `previous_summary`/`open_issue` populated with a prior ETA. Confirm (via
  transcript) the assistant asks "is that still correct?" rather than a
  cold "what is your ETA?". Passed 2026-09-11 (TEST-002) — transcript:
  "Earlier, we were advised that the ETA for delivery was approximately
  3 PM. Is that still correct?"
- [!] **TC-07b MDR-specified questions** — send a request with `questions[]`
  containing something not in the call type's default list. Confirm (via
  transcript) the assistant actually asks it. Run 2026-09-14 (TEST-07b):
  core requirement confirmed — the custom question ("is the recipient
  business open to receive the delivery") was asked. Inconclusive on
  whether the standard call-type default questions also still get covered
  in the same call: this run hit real connection trouble (repeated "can
  you repeat"/"are you there") and ended before reaching
  location/ETA/delay/etc. — all came back `null`. Prompt's intent is
  "custom questions IN ADDITION TO defaults," not instead of them. Re-run
  with a clean connection recommended to fully confirm, not urgent/blocking.

## Special-case outcomes

- [x] **TC-09 NO_ANSWER** — call an unanswered/disconnected test number.
  Expect `event_type: NO_ANSWER`, minimal payload (no `result`), no
  follow-up call triggered by this service. First run 2026-09-14
  (TEST-009) found a real bug: Vapi's actual `endedReason` for an
  unanswered call is `"customer-did-not-answer"`, not `"no-answer"` as
  `ENDED_REASON_MAP` assumed — every no-answer call was silently
  misreported to MDR as `CALL_FAILED`. Fixed in `src/server/callOutcome.ts`
  (server-side only). Re-run 2026-09-14 (TEST-009b) confirms the fix:
  `event_type: "NO_ANSWER"`, console log shows the exact minimal shape
  `{event_type, mdr_call_id, voice_call_id}` with nothing else, matching
  MDR's confirmed contract.
- [x] **TC-10 VOICEMAIL** — call a number that goes to voicemail. Expect the
  approved short message left, `event_type: VOICEMAIL`. Passed 2026-09-14
  (TEST-010): confirmed the actual voicemail recording on the test phone
  played `VOICEMAIL_MESSAGE` correctly, `event_type: "VOICEMAIL"` correct
  (unlike TC-09, this `endedReason` mapping was already right — no
  unrecognized-reason warning), console log shows the minimal pushed shape.
  Minor non-blocking note: TTS pronounced "SHIP-010" as "ship dash ten"
  rather than spelling out digits — data is correct, just a pronunciation
  quirk, not worth fixing now.
- [x] **TC-11 WRONG_CONTACT** — answerer says they don't handle this
  shipment and gives a referral name/number. First run 2026-09-14
  (TEST-011) found two bugs: the assistant wrapped up before actually
  hearing the referred name, and the code papered over the missing data
  with `""` instead of `null`. Both fixed (see `tools.ts`/`prompt.ts` wait-
  for-the-name instruction, `mdr/types.ts`/`webhookHandlers.ts` null not
  empty-string). Re-run 2026-09-14 (TEST-111) — passed:
  `event_type: WRONG_CONTACT`, `tool_flags.referred_contact: {name: "Mike
  Johnson", phone: "312-555-7788"}` correctly captured (including cleanly
  parsing spoken digits "3 1 2 triple 5 double 7 double 8"),
  `confidence_score`/`summary` still populated. This run gave the name and
  phone in one clean turn — the specific "caller pauses mid-sentence"
  recovery phrasing from the first run hasn't been re-tested, but the core
  wait-before-acting behavior is confirmed. This run also incidentally
  reconfirmed TC-20 (see below): push failure logged cleanly, `mdr_pushed_at`
  stayed null.
- [x] **TC-12 CALLBACK_REQUESTED** — answerer asks to be called back in an
  hour. First run 2026-09-14 (TEST-012) found a real bug: after an STT
  mishear + correction ("1 day" -> caller corrects to "1 hour"), the
  assistant verbally acknowledged the correction but never re-called
  `reportCallbackRequested`, so `callback_after_minutes` stayed `1440`
  instead of `60` — conversation sounded right, structured data was wrong.
  Fixed with a general "re-call a tool after any correction" rule in
  `prompt.ts` + a specific reminder in the tool's own description. Re-run
  2026-09-14 (TEST-012-duplicate) confirms the baseline path still works:
  `callback_after_minutes: 60` correctly captured and pushed. NOTE: this
  re-run didn't happen to include a correction, so the specific fix (re-
  calling after a correction) hasn't been directly re-exercised yet — spot-
  check this opportunistically if a future call naturally involves a
  correction, rather than engineering one just for this.
- [x] **TC-13 email requested (internal only)** — answerer asks for info by
  email with an address. Expect `tool_flags.email_requested`/
  `requested_email` set on the `CallRequest` doc — there is currently no
  MDR event_type for this (see `docs/requirements-tracker.md`), so confirm
  it does NOT crash anything and doesn't get silently lost from the DB.
  Passed 2026-09-14 (TEST-013): `email_requested: true`,
  `requested_email` captured verbatim from what was actually said (not
  "cleaned up" to the intended address — correct never-fabricate
  behavior), `event_type` stayed `CALL_COMPLETED` (not hijacked), and the
  pushed MDR payload correctly excluded the internal-only tool_flags while
  `summary`/`next_action` still surfaced the request in prose.
- [x] **TC-14 CALL_DROPPED** — force-disconnect mid-conversation after
  location is given but before ETA. First run 2026-09-14 (TEST-014) found
  a real bug: Vapi's `endedReason` for ANY customer-initiated hangup is the
  same string (`"customer-ended-call"`) whether the caller finished
  normally or the call just dropped mid-sentence — silently classified as
  `CALL_COMPLETED`. Fixed with an internal-only `call_ended_abruptly` field
  in the post-call extraction (not part of MDR's contract, never
  forwarded) used as a tiebreaker in `classifyEventType`. Re-run 2026-09-14
  (TEST-014-duplicate) confirms the fix: `event_type: "CALL_DROPPED"`,
  `call_ended_abruptly: true` detected correctly, `partial_result.eta:
  null` (not guessed), `partial_result.current_location` populated (a bit
  fragmentary since the caller was literally cut off mid-sentence — that's
  correct/expected for a dropped call, not a bug).
- [x] **TC-15 "don't know" answer** — answerer says they don't know the
  ETA. Expect `result.eta: null`, not a fabricated or carried-over value.
  Passed 2026-09-14 (TEST-015): `eta: null` correctly, `current_location`
  still populated since that part was answered, `confidence_score: 0.9`
  reasonable. Also confirmed the internal-only `call_ended_abruptly` field
  shows up in the local `structured_result` but correctly does NOT leak
  into the actual event pushed to MDR.
- [x] **TC-16 human escalation — breakdown** — driver reports a truck
  breakdown. Expect `result.human_escalation_required: true`,
  `result.escalation_reason` briefly stating the breakdown, and
  `event_type` still reflecting how the call itself ended (e.g.
  `CALL_COMPLETED`, not a separate escalation event). Already covered by
  TC-06 (TEST-066, IN_TRANSIT mechanical problem): `human_escalation_required:
  true`, `escalation_reason: "mechanical problem"`, `event_type:
  "CALL_COMPLETED"` — no separate re-run needed.
- [x] **TC-16b human escalation — should NOT trigger** — driver reports a
  routine delay or says "not sure yet" to something. Expect
  `result.human_escalation_required: false`, `result.escalation_reason:
  null` — confirms the assistant isn't over-escalating outside the defined
  trigger list. First attempt 2026-09-14 (TEST-016b) unintentionally
  triggered a REAL escalation (driver said "no" to making the appointment
  on time, which IS a defined trigger — correct behavior, just not the
  negative case we meant to test). Re-run 2026-09-14 (TEST-016c) with the
  appointment confirmed on-time passed: `human_escalation_required: false`,
  `escalation_reason: null`, `delay`/`delay_reason` still captured normally
  — confirms escalation logic reasons about actual criteria (will the
  appointment be missed?) rather than keying off words like "traffic."
  Minor non-blocking inconsistency noted: `issue_type` came back `null`
  here despite `delay_reason: "Traffic"` being populated, whereas TC-16's
  run populated `issue_type` for a similar answer — extraction isn't fully
  consistent about filling both overlapping fields every time.

## Integration edges

- [x] **TC-17 duplicate mdr_call_id** — POST the same `mdr_call_id` twice.
  Expect the second request returns `202 {success:true, status:"QUEUED"}`
  with the existing `voice_call_id`, and does not place a second call.
  Passed 2026-09-14 — re-posted `TEST-011`'s `mdr_call_id`, got back
  `202 {success:true, status:"QUEUED"}` with the exact same `voice_call_id`
  as the original call, confirming no second call was placed.
- [x] **TC-18 missing required field** — POST a payload missing `contact`.
  Expect `400`. Passed 2026-09-14 — also verified missing `shipment` and
  missing `mdr_call_id`, all three correctly return `400`.
- [x] **TC-19 wrong x-api-key** — POST without/with an incorrect
  `x-api-key`. Expect `401`. Passed 2026-09-14 — both a wrong key and a
  missing header correctly return `401`.
- [x] **TC-20 MDR push failure** — with `MDR_API_BASE_URL` pointed at
  something unreachable (the current default), complete a call and confirm
  the failure is logged with the full event payload and `mdr_pushed_at`
  stays null rather than throwing unhandled. Confirmed incidentally via
  TC-11 (TEST-011): console showed `[mdr] WRONG_CONTACT failed for
  TEST-011: TypeError: fetch failed` (DNS failure on the placeholder host),
  logged cleanly, `mdr_pushed_at` stayed null, server kept running.

## MDR multi-shipment feedback (2026-10-06)

Use a new `mdr_call_id` per call. `[x]` = verified on a real call
2026-10-06, `[ ]` = still to run.

- [x] **TC-FB-01 single shipment wording** — one shipment, any status: no
  "First"/"Second", no shipment ID spoken.
- [x] **TC-FB-02 delay cause** — answer "yes" to delay: agent offers
  traffic/weather/mechanical/other; `delay_reason` and `issue_type`
  (`traffic`) filled.
- [x] **TC-FB-03 ETA given -> no "has delivery happened?"** —
  `delivery_completed: false`.
- [x] **TC-FB-04 "already delivered"** — agent asks date/time, no ETA
  question; `delivery_completed: true`, `delivery_completed_at` filled
  ("2 PM", "an hour ago", "yesterday 4 PM"); a vague "earlier" gets one
  follow-up.
- [x] **TC-FB-05 ETA format** — "4 PM" -> today `16:00:00`, "in 2 hours" ->
  call time + 2h, "tomorrow 1 PM" -> next day `13:00:00`; day-only
  ("tomorrow") makes the agent ask for a time.
- [x] **TC-FB-06 dispatcher wording** — `DISPATCHER` contact: third-person
  driver questions, `call_summary` says "the dispatcher".
- [x] **TC-FB-07 DISPATCHED, no driver** — skips the contact questions;
  `driver_assigned: false`, `driver_confirmed: null`, `driver: null`.
- [x] **TC-FB-08 DISPATCHED, driver assigned + contact updated** —
  `driver_confirmed: true`, `driver: null`.
- [x] **TC-FB-09 DISPATCHED, contact NOT updated** — name then phone,
  read-back; `driver_confirmed: false`, `driver.phone` `+1...`.
- [ ] **TC-FB-10 PICKUP_TODAY, no driver** — ETA question skipped (the fix
  was made after the last real call, so this still needs a re-run; the
  rest of the flow was verified).
- [x] **TC-FB-11 invalid `contact.type`** (`CARRIER`, `CARRIER
  REPRESENTATIVE`) / missing name or phone — immediate `400` with the
  allowed list, no hang.
- [ ] **TC-FB-12 phone with country code** (`+91 98765 43210` ->
  `+919876543210`) and **garbled phone** (-> `driver.phone: null`).
- [ ] **TC-FB-13 PICKUP_TODAY, driver assigned** — contact updated, and not
  updated (name + phone); ETA "in 2 hours" format.
- [ ] **TC-FB-14 multi-shipment driver flow** — DISPATCHED + PICKUP_TODAY in
  one call, each shipment follows its own branch.
- [ ] **TC-FB-15 IN_TRANSIT** (driver and dispatcher), **CONTACT_UPDATE_REQUEST**,
  `SECONDARY_DISPATCHER`, and `CARRIER_MAIN`/`AFTER_HOURS`/
  `CARRIER_REPRESENTATIVE` contacts.
- [ ] **TC-FB-16 `delay`/`delivery_completed` stay `null`** when never
  asked (e.g. a `DISPATCHED` call), and `dispatcher` is `null` when no
  dispatcher details were collected.

### Tone / greeting / pickup ETA (2026-10-09)

- [x] **TC-TN-01 polite tone** — soft question wording, 1-3 word
  acknowledgements, no echoing of the caller's answers, same questions/order.
- [x] **TC-TN-02 `calling_from`** — intro and "who is this shipping for?" /
  "what company?" both say the payload's company; the word "broker" is never
  spoken; missing `calling_from` -> "our company".
- [x] **TC-TN-03 closing** — drivers: "Thanks for the update. Drive safe.
  Goodbye."; others: "...Have a good day. Goodbye."; ends ~1s after "Goodbye";
  event `CALL_COMPLETED`.
- [x] **TC-TN-04 public recording URL** — plays inline, `&download=1`
  downloads, wrong key -> 401.
- [x] **TC-TN-05 early "Hello"** — caller says Hello over/just after the
  agent's "Hello." and gets the introduction without waiting; silence ->
  "Hello? Are you there?" ~14s after the agent finishes, call ends at 30s.
- [x] **TC-TN-06 pickup ETA** — `PICKUP_TODAY` with `pickup_date: "2026-10-09
  15:00:00"`: "1 hour late" -> `16:00:00`, "same as before" -> `15:00:00`,
  "5 PM" -> `17:00:00`; IN_TRANSIT still uses the delivery date.
- [x] **TC-TN-07 greeting by name** — "Hi John, this is Everly…"; "No, I'm
  not John" -> continues if they can help; "can't help" / "wrong number" ->
  `WRONG_CONTACT`.
- [ ] **TC-TN-08 caller interruptions on staging** — after answering a
  caller's question the agent repeats its pending question (once missed on
  local), and never ends the call in that turn.

## Known gaps (don't re-file)

- No automated test suite yet — all of the above are manual/curl-driven.
- `MDR_API_BASE_URL`/`MDR_API_AUTH_TOKEN` are deliberately still placeholder
  even though MDR's real webhook URL is confirmed (see
  `docs/requirements-tracker.md`) — TC-20 above is the closest thing to an
  integration test until we're ready to point at the real endpoint.
- `EMAIL_REQUESTED` (TC-13) has no confirmed MDR event_type — don't file
  this as a bug, it's a tracked open question.
