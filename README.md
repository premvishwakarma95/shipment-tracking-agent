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

Five call types: `OUT_FOR_DELIVERY`, `PICKUP_TODAY`, `DISPATCHED`,
`IN_TRANSIT` share one common result shape (`CommonCallResult`).
`CONTACT_UPDATE_REQUEST` (collects driver/dispatcher contact info instead
of a shipment status) is the one deliberate exception — its own result
shape and its own Vapi structured-data extraction, applied per-call. See
CLAUDE.md's "Contact update requests" section before touching either.

See [docs/call-flow.md](./docs/call-flow.md) for the full diagram and
[docs/test-cases.md](./docs/test-cases.md) for manual QA scenarios.

## Docs

- [CLAUDE.md](./CLAUDE.md) — architecture, data model, "don't repeat this" notes.
- [docs/business-requirements.md](./docs/business-requirements.md) — digest of the client's spec.
- [docs/call-flow.md](./docs/call-flow.md) — request lifecycle diagram.
- [docs/requirements-tracker.md](./docs/requirements-tracker.md) — confirmed vs. open questions with MDR.
- [docs/test-cases.md](./docs/test-cases.md) — manual QA scenarios.
