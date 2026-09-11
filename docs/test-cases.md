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
- [ ] **TC-03 PICKUP_TODAY, not yet picked up, driver assigned** — answer
  "no" to "has it been picked up", then confirm driver name/ETA/appointment.
  Expect `result.driver_assigned: true`, `result.eta` populated,
  `result.pickup_completed: false`.
- [ ] **TC-04 PICKUP_TODAY, already picked up** — answer "yes" to "has it
  been picked up". Expect `result.pickup_completed: true`,
  `result.pickup_completed_at` populated if given, and confirm (via
  transcript) the assistant does NOT ask for a driver ETA to pickup.
- [ ] **TC-05 DISPATCHED** — confirm driver/equipment/pickup date/
  appointment as a set of yes/no answers.
- [ ] **TC-06 IN_TRANSIT, mechanical issue** — driver reports a mechanical
  problem short of a breakdown. Expect `result.issue_type: "MECHANICAL"`.

## Previous-context handling

- [x] **TC-07 reconfirmation phrasing** — send a request with
  `previous_summary`/`open_issue` populated with a prior ETA. Confirm (via
  transcript) the assistant asks "is that still correct?" rather than a
  cold "what is your ETA?". Passed 2026-09-11 (TEST-002) — transcript:
  "Earlier, we were advised that the ETA for delivery was approximately
  3 PM. Is that still correct?"
- [ ] **TC-07b MDR-specified questions** — send a request with `questions[]`
  containing something not in the call type's default list. Confirm (via
  transcript) the assistant actually asks it.

## Special-case outcomes

- [ ] **TC-09 NO_ANSWER** — call an unanswered/disconnected test number.
  Expect `event_type: NO_ANSWER`, minimal payload (no `result`), no
  follow-up call triggered by this service.
- [ ] **TC-10 VOICEMAIL** — call a number that goes to voicemail. Expect the
  approved short message left, `event_type: VOICEMAIL`.
- [ ] **TC-11 WRONG_CONTACT** — answerer says they don't handle this
  shipment and gives a referral name/number. Expect `event_type:
  WRONG_CONTACT`, `referred_contact` populated, and confirm no outbound
  call was placed to the referred number.
- [ ] **TC-12 CALLBACK_REQUESTED** — answerer asks to be called back in an
  hour. Expect `event_type: CALLBACK_REQUESTED`, `callback_after_minutes:
  60` (a number, not text), and confirm this service does not self-schedule
  anything.
- [ ] **TC-13 email requested (internal only)** — answerer asks for info by
  email with an address. Expect `tool_flags.email_requested`/
  `requested_email` set on the `CallRequest` doc — there is currently no
  MDR event_type for this (see `docs/requirements-tracker.md`), so confirm
  it does NOT crash anything and doesn't get silently lost from the DB.
- [ ] **TC-14 CALL_DROPPED** — force-disconnect mid-conversation after
  location is given but before ETA. Expect `event_type: CALL_DROPPED`,
  `partial_result.current_location` populated, `partial_result.eta: null`
  (not guessed).
- [ ] **TC-15 "don't know" answer** — answerer says they don't know the
  ETA. Expect `result.eta: null`, not a fabricated or carried-over value.
- [ ] **TC-16 human escalation — breakdown** — driver reports a truck
  breakdown. Expect `result.human_escalation_required: true`,
  `result.escalation_reason` briefly stating the breakdown, and
  `event_type` still reflecting how the call itself ended (e.g.
  `CALL_COMPLETED`, not a separate escalation event).
- [ ] **TC-16b human escalation — should NOT trigger** — driver reports a
  routine delay or says "not sure yet" to something. Expect
  `result.human_escalation_required: false`, `result.escalation_reason:
  null` — confirms the assistant isn't over-escalating outside the defined
  trigger list.

## Integration edges

- [ ] **TC-17 duplicate mdr_call_id** — POST the same `mdr_call_id` twice.
  Expect the second request returns `202 {success:true, status:"QUEUED"}`
  with the existing `voice_call_id`, and does not place a second call.
- [ ] **TC-18 missing required field** — POST a payload missing `contact`.
  Expect `400`.
- [ ] **TC-19 wrong x-api-key** — POST without/with an incorrect
  `x-api-key`. Expect `401`.
- [ ] **TC-20 MDR push failure** — with `MDR_API_BASE_URL` pointed at
  something unreachable (the current default), complete a call and confirm
  the failure is logged with the full event payload and `mdr_pushed_at`
  stays null rather than throwing unhandled.

## Known gaps (don't re-file)

- No automated test suite yet — all of the above are manual/curl-driven.
- `MDR_API_BASE_URL`/`MDR_API_AUTH_TOKEN` are deliberately still placeholder
  even though MDR's real webhook URL is confirmed (see
  `docs/requirements-tracker.md`) — TC-20 above is the closest thing to an
  integration test until we're ready to point at the real endpoint.
- `EMAIL_REQUESTED` (TC-13) has no confirmed MDR event_type — don't file
  this as a bug, it's a tracked open question.
