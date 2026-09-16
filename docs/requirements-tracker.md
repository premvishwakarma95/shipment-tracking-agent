# Requirements Tracker

Single source of truth for what's confirmed vs. still open with MDR. Update
this as answers come in — don't let it drift the way some of the reference
project's docs did.

## OPEN — needs an answer from MDR before this can go live

1. **`EMAIL_REQUESTED` has no event_type in the confirmed webhook event
   list** (NO_ANSWER/VOICEMAIL/BUSY/CALL_FAILED/CALL_DROPPED/
   CALLBACK_REQUESTED/WRONG_CONTACT/CALL_COMPLETED only). We still capture
   it internally (`tool_flags.email_requested`/`requested_email`) but don't
   send it as its own event yet. Ask MDR whether it needs one, or whether
   folding it into a `CALL_COMPLETED` summary is sufficient.
2. **`VOICEMAIL`/`BUSY`/`CALL_FAILED` payload shape is assumed identical to
   the `NO_ANSWER` example** (minimal `{event_type, mdr_call_id,
   voice_call_id}`) — the guide only shows a worked example for
   `NO_ANSWER`. Confirm the other three match.
3. **`next_action` in the `CALL_COMPLETED` result** is named in the guide's
   prose (§7, "structured AI results such as ... summary and next action")
   but absent from the one worked JSON example. Confirm whether to keep it.
4. **Retry policy** if a push to MDR fails. Currently: log and leave
   `mdr_pushed_at` null for manual reconciliation, no automatic retry.
5. **Voicemail message copy** — currently a generic short message; confirm
   final approved copy.
6. **`questions[]` — is it a fixed/pre-defined set or free text?** MDR asked
   whether custom questions are mandatory (no — optional, defaults to `[]`)
   and whether more can be added (yes, no cap, handled as a priority list
   in addition to call-type defaults). Flagged back to MDR: for reliable
   behavior and QA, we need a finite pre-defined list of possible questions
   to train/test against, not fully arbitrary free text — arbitrary
   questions outside the fixed result schema only land in `call_summary`,
   not as their own structured field. Awaiting MDR's list.

## CONFIRMED (from "MDR Agent 3 – Voice API Integration Guide")

- MDR sends exactly one contact + one shipment per call request; Voice API
  never selects an alternate number or the next contact.
- MDR owns all retry/cadence/next-contact/escalation decisions — Voice API
  only reports outcomes.
- Real webhook URL for pushing results, confirmed directly by the MDR team
  2026-09-16 (supersedes the integration guide's originally-described path):
  `POST https://staging.mydrayrate.com/api/voice/check-call-completed`, one
  shared URL for every event type, differentiated by `event_type`. Auth:
  Bearer token (`MDR_API_AUTH_TOKEN`), also confirmed 2026-09-16 — this is
  now live in both local and staging `.env`, no longer a placeholder.
- Immediate ack shape for `POST /mdr/call-requests`:
  `{success: true, mdr_call_id, voice_call_id, status: "QUEUED"}`. Voice API
  must not hold the request open until the call finishes.
- Inbound request now includes an explicit `questions[]` array (what MDR
  specifically wants asked this call) alongside `previous_summary` and
  `open_issue` (singular strings — NOT the earlier `previous_interactions[]`/
  `open_items[]` arrays).
- 4 call types: OUT_FOR_DELIVERY, PICKUP_TODAY, DISPATCHED, IN_TRANSIT.
  `PICKUP_TODAY` has a required first branch: ask whether pickup already
  happened before asking driver/ETA questions (MDR may still trigger this
  call type even after pickup happened, since TAI can lag).
- 5 contact types: DRIVER, DISPATCHER, SECONDARY_DISPATCHER, CARRIER_MAIN,
  AFTER_HOURS.
- One common `result` structure for every call type (guide §7A) — same
  field names regardless of `call_type`, irrelevant fields simply `null`.
  `true` = confirmed yes, `false` = confirmed no, `null` = unknown/not
  asked/not applicable.
- `appointment_status` enum: CONFIRMED, NOT_CONFIRMED, COMPLETED, MISSED,
  UNKNOWN. Voice API does NOT compute `AT_RISK` — that's MDR's job,
  comparing ETA/appointment time/current time/TAI data Voice API doesn't
  have.
- `confidence_score` (0.00–1.00) means how confident the AI is that it
  correctly understood the conversation — NOT a shipment-risk or carrier
  rating.
- `callback_after_minutes` is a number, not free text.
- **Escalation rule (confirmed):** `human_escalation_required = true` only
  for: truck breakdown/mechanical failure, an accident, driver cannot
  complete the move, carrier cannot perform the load, an appointment will
  definitely be missed, a serious safety issue, the contact specifically
  asks for a human, an important answer can't be confidently understood, or
  another serious operational issue outside the normal flow. When true,
  `escalation_reason` must briefly state which condition applied. When
  false, `escalation_reason` is `null`. See `docs/business-requirements.md`
  and the "Escalation" section of `prompt.ts`/`resultSchema.ts`.
- Unknown/unconfirmed fields must be `null` in the result — never fabricate
  or infer from prior context.
- **`call_summary` (2026-09-16, renamed from `summary` at MDR's request):**
  every response's per-call summary field (`CommonCallResult.call_summary`,
  and the top-level field on `CALL_DROPPED`/`CALLBACK_REQUESTED`) is named
  `call_summary` so MDR can copy it directly into `CallRequestPayload`'s
  `previous_summary` on their next call request for the same
  shipment/contact, without remapping field names.
- **`open_issue` added to the result (2026-09-16, requested by MDR):**
  `CommonCallResult.open_issue` — a nullable string, extracted post-call,
  describing anything raised on this call that's still unresolved and
  should be flagged on the NEXT call to this shipment/contact. Deliberately
  named to mirror `CallRequestPayload.open_issue` (the inbound field) so
  MDR can round-trip it directly: take this call's output `open_issue` and
  send it back as the next call's input `open_issue`.
