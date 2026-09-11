# Requirements Tracker

Single source of truth for what's confirmed vs. still open with MDR. Update
this as answers come in — don't let it drift the way some of the reference
project's docs did.

## OPEN — needs an answer from MDR before this can go live

1. **Sync ack vs. async push-back.** This implementation responds `202`
   immediately to `POST /mdr/call-requests` and pushes the structured
   result later, once the call ends, via `src/mdr/api.ts`. Confirm this
   matches what MDR's system expects (vs. e.g. MDR polling a status
   endpoint instead).
2. **Real MDR API details** — base URL, auth scheme (currently assumed
   Bearer token in `src/mdr/client.ts`), and the exact endpoint path for
   pushing a call result (currently a placeholder constant in
   `src/mdr/api.ts`).
3. **Retry policy** if a push to MDR fails. Currently: log and leave
   `mdr_pushed_at` null for manual reconciliation, no automatic retry.
4. **Voicemail message copy** — currently a generic short message per the
   spec's suggested wording (§11); confirm final approved copy.
5. **Wire-level field casing/shape** for the inbound call-request payload —
   currently built against the exact example in the client's instructions
   PDF (§2); confirm MDR's real integration matches it exactly (especially
   the permissive `shipment` object — what extra TAI fields actually show
   up).

## CONFIRMED (from the client's instructions PDF)

- MDR sends exactly one contact + one shipment per call request; Voice API
  never selects an alternate number or the next contact.
- MDR owns all retry/cadence/next-contact/escalation decisions — Voice API
  only reports outcomes.
- 4 call types: OUT_FOR_DELIVERY, PICKUP_TODAY, DISPATCHED, IN_TRANSIT,
  each with its own question set.
- 5 contact types: DRIVER, DISPATCHER, SECONDARY_DISPATCHER, CARRIER_MAIN,
  AFTER_HOURS.
- `previous_interactions`/`open_items` are supplied by MDR on every
  request — Voice API does not maintain its own cross-call history.
- Unknown/unconfirmed fields must be `null` in the result — never fabricate
  or infer from prior context.
- At minimum 9 call_status values: COMPLETED, NO_ANSWER, LEFT_VOICEMAIL,
  BUSY, CALL_FAILED, CALL_DROPPED, WRONG_CONTACT, CALLBACK_REQUESTED,
  EMAIL_REQUESTED.
