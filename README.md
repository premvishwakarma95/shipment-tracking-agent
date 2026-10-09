# MDR Agent 3 — Shipment Check-Call Voice Agent

A voice AI agent that makes a single outbound check-call per request from
MDR, conducts the conversation via Vapi, and pushes a structured result
back. MDR decides who to call and why; this service only places the call
and reports what happened — it does not schedule, retry, or pick the next
contact itself.

For the full architecture, request lifecycle, and data model, see
[CLAUDE.md](./CLAUDE.md) — that file is kept in sync with the code and is
the source of truth if anything here goes stale.

## Stack

Node.js + TypeScript (strict, ESM), Express, Mongoose/MongoDB, [Vapi](https://vapi.ai)
for voice, `tsx` for dev/scripts. No test framework or linter yet.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — see comments in the file
```

Required before the server can do anything useful:

- `MONGODB_URI` — a reachable MongoDB instance.
- `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` — from your Vapi account.
- `VAPI_ASSISTANT_NAME` — name given to the Vapi assistant on create/patch (e.g. `Agent 3 (stagging)` / `Agent 3 (production)`) — distinguishes environments in the Vapi dashboard; `assistant:create` throws if unset.
- `PUBLIC_BASE_URL` — a publicly reachable URL for this service (e.g. an `ngrok` tunnel in dev). Vapi cannot reach `localhost` to deliver webhooks.
- `MDR_WEBHOOK_SHARED_SECRET` — the `x-api-key` value MDR (or your test requests) must send.
- `RECORDINGS_PROXY_SECRET` — the `?key=` value on the public recording links sent to MDR.
- `MDR_API_BASE_URL` / `MDR_API_AUTH_TOKEN` — real values, confirmed directly by MDR 2026-09-16 (Bearer token auth). Get the token from whoever holds MDR credentials — never commit a real one to `.env.example`.

## Scripts

| Command                    | What it does                                                          |
| --------------------------- | ---------------------------------------------------------------------- |
| `npm run server:dev`       | Runs the Express server in watch mode.                                |
| `npm run assistant:create` | Creates/updates the Vapi assistant from `src/assistant/*` config.     |
| `npm run db:reset`         | Dev-only: clears `CallRequest` documents (never `RawCapture`).        |
| `npm run typecheck`        | `tsc --noEmit`.                                                        |

## Request flow (short version)

1. MDR sends one contact + shipment + call instructions to `POST /mdr/call-requests`.
2. This service places the call via Vapi and responds `202` immediately.
3. Once the call ends, Vapi's webhooks land on `POST /vapi/tool-calls`; the result is assembled and pushed back to MDR.

One call can cover several shipments (`shipments[]`, `call_type` is
`SHIPMENT_GROUP`). Each shipment's own `status` (`OUT_FOR_DELIVERY`,
`PICKUP_TODAY`, `DISPATCHED`, `IN_TRANSIT`, or `CONTACT_UPDATE_REQUEST`)
picks its question set, and every shipment returns the same result shape
(`CommonCallResult`). `eta`, `pickup_completed_at` and
`delivery_completed_at` are `YYYY-MM-DD HH:MM:SS` in UTC; phone numbers in
`driver`/`dispatcher` carry a country code. `contact.type` must be one of
`DRIVER`, `DISPATCHER`, `SECONDARY_DISPATCHER`, `CARRIER_MAIN`,
`AFTER_HOURS`, `CARRIER_REPRESENTATIVE` — anything else gets an immediate
`400`. The request may carry a top-level `calling_from` (company name Everly
says she is calling on behalf of — used in the introduction and when asked;
"our company" if absent; the word "broker" is never spoken). The
`recording_url` sent to MDR is a public link,
`<PUBLIC_BASE_URL>/recordings/<vapi_call_id>?key=<RECORDINGS_PROXY_SECRET>`
(add `&download=1` to download). The agent greets the contact by first name
(`contact.name`). For `PICKUP_TODAY` shipments send `pickup_date` as
`YYYY-MM-DD HH:MM:SS` (UTC) — "N hours late" is added to that scheduled pickup
time. See CLAUDE.md's "Multi-shipment calls" and "MDR multi-shipment
feedback changes" sections.

See [docs/call-flow.md](./docs/call-flow.md) for the full diagram and
[docs/test-cases.md](./docs/test-cases.md) for manual QA scenarios.

## Docs

- [CLAUDE.md](./CLAUDE.md) — architecture, data model, "don't repeat this" notes.
- [docs/business-requirements.md](./docs/business-requirements.md) — digest of the client's spec.
- [docs/call-flow.md](./docs/call-flow.md) — request lifecycle diagram.
- [docs/requirements-tracker.md](./docs/requirements-tracker.md) — confirmed vs. open questions with MDR.
- [docs/test-cases.md](./docs/test-cases.md) — manual QA scenarios.
