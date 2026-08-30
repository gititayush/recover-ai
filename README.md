# RecoverAI

RecoverAI is an AI-assisted revenue recovery system for the Razorpay Buildathon 2026. This first milestone implements a working foundation: normalized event ingestion, deterministic revenue-risk detection, PostgreSQL persistence, recovery cases, audit history, a Node simulator, and a React operations dashboard.

## Current architecture

`event -> validation/idempotency -> revenue event -> deterministic risk detector -> RecoveryCase + audit trail -> REST API -> dashboard`

See [docs/architecture.md](docs/architecture.md) for details.

## Prerequisites

- Node.js 20 or later
- PostgreSQL 15 or later
- pnpm 9 or later (or an equivalent package-manager workflow)

## Local setup

1. Create a PostgreSQL database named `recoverai`.
2. Copy `.env.example` to `.env` and update `DATABASE_URL` if needed.
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

## APIs

- `GET /health`
- `POST /api/events` — accepts a normalized payment event. Required: `eventId`, `eventType`, `paymentId`, `amount` (smallest currency unit), `currency`, and ISO 8601 `timestamp`.
- `GET /api/cases`
- `GET /api/cases/:id` — includes event history and audit timeline.

## Tests

```sh
pnpm test
pnpm frontend:build
```

Tests use an in-memory repository to exercise the HTTP and workflow behavior without requiring a locally running PostgreSQL instance. The production server uses PostgreSQL.

## Current limitations

- No LLM integration or advanced diagnosis.
- No Razorpay API actions, webhook-signature verification, or live credentials.
- No financial action executor or policy layer yet; those will be added before any financial operation is enabled.
- The simulator uses fixed local events and is only for this first vertical slice.
