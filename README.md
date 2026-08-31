# RecoverAI

RecoverAI is an AI-assisted revenue recovery system for the Razorpay Buildathon 2026. It currently implements reliable event ingestion, deterministic revenue-risk detection, PostgreSQL persistence, recovery cases, audit history, a Node simulator, and a React operations dashboard.

## Current architecture

`event -> normalized event service -> deterministic risk detector -> RecoveryCase + audit trail -> REST API -> dashboard`

Razorpay is an event source; the normalized event service is the canonical business-processing boundary. The Razorpay endpoint is a signed adapter in front of that boundary, not a second case-processing system.

AI proposes. Deterministic application logic evaluates. Policy will later authorize. The executor will later perform the bounded action.

See [docs/architecture.md](docs/architecture.md) for details.

## Prerequisites

- Node.js 20 or later
- PostgreSQL 15 or later
- pnpm 9 or later (or an equivalent package-manager workflow)

## Local setup

1. Create a PostgreSQL database named `recoverai`.
2. Copy `.env.example` to `.env` and update `DATABASE_URL` if needed.
   Set `RAZORPAY_WEBHOOK_SECRET` when testing webhook delivery. `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are reserved for a later integration milestone and are not used yet.
   Leave `AI_API_KEY` blank to use the explicitly labeled deterministic development fallback. Configure `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, and `AI_CONFIDENCE_THRESHOLD` only when using a compatible external provider.
3. Apply the schema:

   ```sh
   pnpm db:migrate
   ```

4. Install dependencies:

   ```sh
   pnpm install
   pnpm --dir frontend install
   ```

## Run locally

In separate terminals:

```sh
pnpm start
pnpm frontend
pnpm simulate
```

The backend is at `http://localhost:3001`; the dashboard is at `http://localhost:5173`.

### Replay Razorpay fixtures

With the backend and PostgreSQL running, replay the deterministic, Razorpay-shaped fixtures through the actual HTTP webhook route:

```sh
pnpm replay:razorpay
```

The utility reads the raw fixture bytes, signs each payload with `RAZORPAY_WEBHOOK_SECRET`, and calls `POST /api/webhooks/razorpay`. It therefore exercises signature verification, provider-event idempotency, normalization, and the canonical event pipeline. It does not bypass the endpoint.

## APIs

- `GET /health`
- `POST /api/events` — accepts a normalized payment event. Required: `eventId`, `eventType`, `paymentId`, `amount` (smallest currency unit), `currency`, and ISO 8601 `timestamp`.
- `POST /api/webhooks/razorpay` — receives a Razorpay Test Mode-compatible webhook. It reads the exact raw request body, verifies `X-Razorpay-Signature` using HMAC-SHA256 and `RAZORPAY_WEBHOOK_SECRET`, requires `x-razorpay-event-id`, stores the authenticated raw body, normalizes supported events, and delegates to the existing event service.
- `GET /api/cases`
- `GET /api/cases/:id` — includes event history and audit timeline.
- `POST /api/cases/:id/diagnosis` — builds minimized case context, generates or returns one cached diagnosis proposal, persists it, and appends an `AI_DIAGNOSIS` audit event. It has no financial side effect.
- `GET /api/cases/:id/diagnosis` — retrieves an accepted stored diagnosis.

The Razorpay adapter supports `payment.failed`, `payment.authorized`, `payment.captured`, and `order.paid`. It rejects missing/invalid signatures before persistence or business processing. Authenticated malformed or unsupported deliveries are retained with `FAILED` processing status for diagnosis; valid duplicates return safely without additional state transitions.

## Tests

```sh
pnpm test
pnpm frontend:build
```

Tests use an in-memory repository to exercise the HTTP and workflow behavior without requiring a locally running PostgreSQL instance. The production server uses PostgreSQL.

Webhook fixtures live in `backend/test/fixtures/razorpay`. They are deterministic Razorpay-shaped test data, not claimed production captures. Tests cover raw-body HMAC validation, missing/invalid signatures, provider delivery idempotency, malformed/unsupported payloads, supported normalization, failure-to-capture resolution, and late-failure ordering behavior.

## AI diagnosis proposals

The AI layer runs only when `POST /api/cases/:id/diagnosis` is requested; dashboard refreshes do not invoke it. It receives a minimized, structured context: case value/currency/status/risk, latest payment/order state, recorded failure reason, failure count, elapsed failure time, and up to five normalized event summaries. It excludes raw webhook bodies, credentials, secrets, and customer references.

Providers must return strict JSON with a diagnosis cause, `0..1` confidence, evidence entries that exactly reference supplied context fields, and one of three actions: `CREATE_PAYMENT_LINK`, `REQUEST_MANUAL_REVIEW`, or `NO_ACTION`. Invalid JSON, unsupported actions, absent evidence, or evidence inconsistent with the context are rejected.

The application compares conceptual candidates with the transparent heuristic formula:

```text
estimated recovery value = estimated probability × recoverable amount
                           − intervention cost − estimated friction
```

The probability rules and costs are versioned as `recovery-heuristic-v1` and are explicitly heuristic—not learned, measured, or claimed recovery performance. Low AI confidence becomes `REQUEST_MANUAL_REVIEW`; terminal cases become `NO_ACTION` without contacting an AI provider.

When `AI_API_KEY` is absent, a deterministic development fallback produces clearly labeled `development_fallback` decisions for reproducible local development. It must not be used to claim AI performance metrics.

## Current limitations

- AI diagnosis proposals are available, but no decision is policy-authorized or executed.
- No live Razorpay delivery has been verified in this repository; only deterministic signed fixtures have been tested.
- No Razorpay API actions or live credentials are used.
- No financial action executor or policy layer yet; those will be added before any financial operation is enabled.
- No financial action, payment link, capture request, refund, retry, or customer message is implemented.
