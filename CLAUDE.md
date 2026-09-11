# MDR Agent 3 — Engineering Brief

This is the authoritative, kept-in-sync doc for this repo — if something
here disagrees with the code, the code is what shipped; fix this file.

## Architecture in one paragraph

**Reactive, per-request. No dispatch engine, no cron loop, no cadence
logic.** MDR decides who to call, why, and when, and sends exactly one
contact + one shipment + call instructions per HTTP request. This service's
entire job is: accept that request, place the call via Vapi, and — once
Vapi's `end-of-call-report` webhook arrives, minutes later — push a
structured result back to MDR. It never decides the next contact, never
retries on its own, and never maintains its own cross-call history store:
MDR supplies `previous_interactions`/`open_items` on every request instead.
**Do not add a scheduler/dispatcher back in** — there is nothing left for
this service to decide.

## Request lifecycle

1. `POST /mdr/call-requests` (`src/server/mdrCallRequest.ts`) — raw-captures
   the payload, validates loosely, creates a `CallRequest`, places the
   outbound call via `src/vapi/calls.ts`, responds `202` immediately.
2. Vapi calls the contact, runs the conversation per
   `src/assistant/prompt.ts`, calling one of the 4 tools in
   `src/assistant/tools.ts` if a special-case outcome comes up.
3. `POST /vapi/tool-calls` (`src/server/index.ts` → `webhookHandlers.ts`)
   receives both Vapi's `tool-calls` events (writes `tool_flags` on the
   `CallRequest`) and its `end-of-call-report` (classifies the final
   `call_status`, assembles the result, pushes to MDR via `src/mdr/api.ts`).

See `docs/call-flow.md` for the diagram.

## Env vars

See `.env.example` — every non-obvious one has a comment explaining why it
exists. The three under "Outbound: Voice API -> MDR" are placeholders as of
2026-09; MDR hasn't confirmed real values yet (see
`docs/requirements-tracker.md`).

## Data model

Only two Mongo collections:

- `CallRequest` (`src/db/models/CallRequest.ts`) — intentionally thin. It
  exists only to bridge the gap between "we told Vapi to dial" and "Vapi's
  webhooks tell us what happened." It is NOT a history store — don't add
  cross-call queries against it the way the reference project's
  `callMemory.ts` did; MDR already sends history per request.
  `lifecycle_status` (internal bookkeeping: have we heard back from Vapi
  yet?) and `call_status` (MDR-facing outcome: what happened on the call?)
  are deliberately separate fields — don't collapse them.
- `RawCapture` — unconditional, unparsed capture of every inbound payload
  (both MDR call requests and Vapi webhooks), written before any parsing.
  Audit safety net for payload shapes that aren't fully locked down yet.
  Never cleared by `npm run db:reset`.

## Tool calls vs. post-call extraction

In-call Vapi tools (`src/assistant/tools.ts`) exist ONLY for the four
flow-altering outcomes (wrong contact, callback requested, email requested,
human escalation) — never for data fields. All ~15 data fields (location,
eta, delay, etc.) come from Vapi's post-call structured-data extraction
(`src/assistant/resultSchema.ts`), evaluated once against the full
transcript with an explicit "null if unconfirmed, never infer" instruction.
If you're tempted to add a tool parameter for a data value, don't — see the
"Tool usage rules" section of `prompt.ts` for why that breaks the
never-fabricate requirement.

## Known gaps / don't repeat these

- The MDR API integration (`src/mdr/`) is built against placeholder
  endpoint/auth details, not a confirmed spec. Update `client.ts`'s base
  URL/auth and `api.ts`'s endpoint constant once MDR shares real values —
  nothing else should need to change (`CallResultPayload` in `mdr/types.ts`
  is dictated by the client's own requirements doc, not by MDR's internal
  API).
- There is no retry queue for a failed push to MDR (`mdr.pushCallResult`
  failing leaves `mdr_pushed_at` null for manual reconciliation). Don't add
  one speculatively — get a retry policy from MDR first
  (`docs/requirements-tracker.md`).
