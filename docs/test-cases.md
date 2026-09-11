# Manual Test Cases

Status legend: `[ ]` not run · `[x]` pass · `[!]` fail, see notes.

Setup: run `npm run server:dev`, tunnel it (e.g. `ngrok http 3000`), set
`PUBLIC_BASE_URL` to the tunnel URL, run `npm run assistant:create` once.
Send test payloads with `curl -X POST $PUBLIC_BASE_URL/mdr/call-requests -H "x-api-key: $MDR_WEBHOOK_SHARED_SECRET" -H "Content-Type: application/json" -d @payload.json`.

## Core call types

- [ ] **TC-01 OUT_FOR_DELIVERY, no delay** — driver confirms location/ETA,
  no issues. Expect `call_status: COMPLETED`, `delay: false`, `issue_type:
  null`.
- [ ] **TC-02 OUT_FOR_DELIVERY, delay** — driver reports traffic delay.
  Expect `delay: true`, `delay_minutes` populated, `traffic_issue: true`,
  `appointment_status: AT_RISK`.
- [ ] **TC-03 PICKUP_TODAY, driver assigned** — dispatcher confirms driver
  name, ETA, appointment. Expect `driver_assigned: true`, `eta` populated.
- [ ] **TC-04 PICKUP_TODAY, driver not yet assigned** — dispatcher says no
  driver yet. Expect `driver_assigned: false`, `issue_type` reflecting it.
- [ ] **TC-05 DISPATCHED** — confirm driver/equipment/pickup date/
  appointment as a set of yes/no answers.
- [ ] **TC-06 IN_TRANSIT, mechanical issue** — driver reports a mechanical
  problem short of a breakdown. Expect `mechanical_issue: true`.

## Previous-context handling

- [ ] **TC-07 reconfirmation phrasing** — send a request with
  `previous_interactions`/`open_items` populated with a prior ETA. Confirm
  (via transcript) the assistant asks "is that still correct?" rather than
  a cold "what is your ETA?".
- [ ] **TC-08 eta_changed** — same as TC-07, but the driver gives a
  different ETA on this call. Expect `eta_changed: true`,
  `previous_eta`/`eta` both populated and different.

## Special-case outcomes

- [ ] **TC-09 NO_ANSWER** — call an unanswered/disconnected test number.
  Expect `call_status: NO_ANSWER`, `answered: false`, no follow-up call
  triggered by this service.
- [ ] **TC-10 LEFT_VOICEMAIL** — call a number that goes to voicemail.
  Expect the approved short message left, `voicemail_left`-equivalent
  reflected via `call_status: LEFT_VOICEMAIL`.
- [ ] **TC-11 WRONG_CONTACT** — answerer says they don't handle this
  shipment and gives a referral name/number. Expect `call_status:
  WRONG_CONTACT`, `result.referred_contact` populated, and confirm no
  outbound call was placed to the referred number.
- [ ] **TC-12 CALLBACK_REQUESTED** — answerer asks to be called back in an
  hour. Expect `call_status: CALLBACK_REQUESTED`, `callback_time`
  populated, and confirm this service does not self-schedule anything.
- [ ] **TC-13 EMAIL_REQUESTED** — answerer asks for info by email with an
  address. Expect `call_status: EMAIL_REQUESTED`, `requested_email` exactly
  as given.
- [ ] **TC-14 CALL_DROPPED** — force-disconnect mid-conversation after
  location is given but before ETA. Expect `call_status: CALL_DROPPED`,
  `conversation_complete: false`, partial `information_collected` with
  `eta: null` (not guessed).
- [ ] **TC-15 "don't know" answer** — answerer says they don't know the
  ETA. Expect `eta: null`, not a fabricated or carried-over value.
- [ ] **TC-16 human escalation** — driver reports a breakdown. Expect
  `human_escalation_required: true` while `call_status` still reflects how
  the call itself ended (e.g. `COMPLETED`, not a separate status).

## Integration edges

- [ ] **TC-17 duplicate mdr_call_id** — POST the same `mdr_call_id` twice.
  Expect the second request returns `202 already_accepted` and does not
  place a second call.
- [ ] **TC-18 missing required field** — POST a payload missing `contact`.
  Expect `400`.
- [ ] **TC-19 wrong x-api-key** — POST without/with an incorrect
  `x-api-key`. Expect `401`.
- [ ] **TC-20 MDR push failure** — with `MDR_API_BASE_URL` pointed at
  something unreachable, complete a call and confirm the failure is
  logged and `mdr_pushed_at` stays null rather than throwing unhandled.

## Known gaps (don't re-file)

- No automated test suite yet — all of the above are manual/curl-driven.
- `src/mdr/` is built against placeholder endpoint/auth details (see
  `docs/requirements-tracker.md`); TC-20 above is the closest thing to an
  integration test until real MDR credentials exist.
