# RecoverAI

RecoverAI is an AI-assisted revenue recovery system for the Razorpay Buildathon 2026 (Track 03 — AI Revenue Recovery). It implements reliable event ingestion, deterministic revenue-risk detection, PostgreSQL persistence, recovery cases, audit history, AI diagnosis proposals, a deterministic policy engine, and a bounded recovery executor for Razorpay Standard Payment Links in Test Mode.

## Current architecture

```text
Razorpay Webhook / Event (payment.failed)
  ↓
Normalized Event Service → Deterministic Risk Detector → RecoveryCase + Audit Trail
  ↓
AI Diagnosis Proposal (Advisory)
  ↓
Deterministic Policy Engine (Authoritative Guardrails)
  ↓ (ALLOW)
Bounded Recovery Executor → Razorpay Standard Payment Link API (Test Mode)
  ↓
Recovery Action Persisted & Audited (ACTION EXECUTED / PAYMENT PENDING)
  ↓
Customer Payment via Payment Link
  ↓
Razorpay Outcome Webhook (payment_link.paid / payment.captured / order.paid)
  ↓
Outcome Reconciliation Service (Multi-Strategy Correlation + Amount/Currency Integrity Verification)
  ↓ (VERIFIED)
Recovery Action: OUTCOME_CONFIRMED | Case: RESOLVED / RECOVERED (recovered_amount credited)
  ↓
Audit Trail: RECOVERY_OUTCOME_RECEIVED → RECOVERY_OUTCOME_VERIFIED → REVENUE_RECOVERED → CASE_UPDATED
```

**Key Architectural Rules**:
1. **AI is advisory; Policy Engine is authoritative**: The executor is the ONLY component permitted to invoke external Razorpay payment infrastructure.
2. **Action Execution $\neq$ Revenue Recovered**: Creating a Payment Link marks `ACTION EXECUTED` (status: `EXECUTED`). It does **NOT** equal recovered revenue. Only a verified, amount-matched provider payment event produces `MONEY RECOVERED` (status: `OUTCOME_CONFIRMED`, `recovered_amount` credited).

See [docs/architecture.md](docs/architecture.md) for full technical details.

## Prerequisites

- Node.js 20 or later
- PostgreSQL 15 or later
- pnpm 9 or later (or an equivalent package-manager workflow)

## Local setup

1. Create a PostgreSQL database named `recoverai`.
2. Copy `.env.example` to `.env` and update `DATABASE_URL` if needed.
   Set `RAZORPAY_WEBHOOK_SECRET` when testing webhook delivery. Set `RAZORPAY_KEY_ID` (`rzp_test_...`) and `RAZORPAY_KEY_SECRET` when testing live Razorpay Test Mode Payment Link creation.
   Leave `AI_API_KEY` blank to use the deterministic development fallback. Configure `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, and `AI_CONFIDENCE_THRESHOLD` only when using a compatible external provider.
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

The backend runs at `http://localhost:3001`; the dashboard runs at `http://localhost:5173`.

### Replay Razorpay fixtures

With the backend and PostgreSQL running, replay the deterministic, Razorpay-shaped fixtures through the actual HTTP webhook route:

```sh
pnpm replay:razorpay
```

The utility reads raw fixture bytes, signs each payload with `RAZORPAY_WEBHOOK_SECRET`, and calls `POST /api/webhooks/razorpay`. It exercises signature verification, provider-event idempotency, normalization, and the canonical event pipeline.

## APIs

- `GET /health`
- `GET /api/recovery/metrics` — returns aggregate revenue metrics: `revenue_at_risk`, `revenue_recovered`, `recovery_rate`, `open_cases`, `resolved_cases`, `confirmed_recoveries`, `pending_recoveries`.
- `POST /api/events` — accepts a normalized payment event. Required: `eventId`, `eventType`, `paymentId`, `amount` (paise), `currency`, and `timestamp`.
- `POST /api/webhooks/razorpay` — receives Razorpay Test Mode webhooks. Verifies HMAC-SHA256 signature, deduplicates provider event IDs, stores authenticated raw payloads, normalizes supported events, reconciles recovery outcomes, and updates recovery cases.
- `GET /api/cases` — lists all recovery cases.
- `GET /api/cases/:id` — includes event history, audit timeline, recovery actions, and verified recovery outcomes.
- `GET /api/cases/:id/recovery-outcome` — returns outcome records and verification status for a case.
- `POST /api/cases/:id/diagnosis` — generates or retrieves cached AI diagnosis proposal. Has no financial side effect.
- `GET /api/cases/:id/diagnosis` — retrieves stored AI diagnosis.
- `POST /api/cases/:id/policy` — evaluates AI proposal against deterministic policy rules and returns structured decision (`ALLOW`, `REVIEW`, `BLOCK`).
- `POST /api/cases/:id/recovery-actions` — re-evaluates policy server-side and executes a policy-approved `CREATE_PAYMENT_LINK` recovery action via Razorpay Test Mode API.
- `GET /api/cases/:id/recovery-actions` — lists executed or attempted recovery actions for a case.

## Policy Engine & Guardrail Rules (`recoverai-policy-v1`)

The deterministic policy engine (`backend/src/policy/policyEngine.js`) evaluates 12 explicit safety rules before any recovery action can execute:

1. **Terminal Payment**: Blocks action if payment is already captured, paid, or refunded (`paymentStatus` or `orderStatus === 'paid'`).
2. **Case Terminal Status**: Blocks action if case is `RESOLVED` or `SUPPRESSED`.
3. **Action Allowlist**: Only `CREATE_PAYMENT_LINK` is executable in this milestone.
4. **Confidence Threshold**: Requires AI confidence $\ge 0.65$ (configurable); otherwise triggers `REVIEW`.
5. **Max Automated Attempts**: Limits automated recovery attempts to 2 per case; further attempts trigger `REVIEW`.
6. **Duplicate Action**: Blocks execution if an active or executed recovery action already exists for the case.
7. **Amount Integrity**: Ensures case amount is positive and valid; AI cannot alter amount.
8. **High-Value Escalation**: Amounts $> \text{₹}25,000$ (2,500,000 paise) trigger `REVIEW` for human oversight.
9. **Cooldown Period**: Enforces 30-minute cooldown between automated attempts for the same case.
10. **Context Integrity**: Blocks execution if required case fields (`paymentId`, `amount`, `currency`) are missing.
11. **Test Mode Check**: Blocks execution unless configured for Razorpay Test Mode (`rzp_test_...`).
12. **Stop on Resolved Outcome**: Stops execution if payment outcome was resolved or refunded.

## Bounded Recovery Executor

The recovery executor (`backend/src/actions/paymentLinkExecutor.js`):
- Re-validates policy approval server-side prior to execution.
- Generates a deterministic idempotency key (`razorpay_case_{id}_plink_v{attempt}`).
- Calls Razorpay Standard Payment Link API (`POST /v1/payment_links`).
- Stores the returned `provider_action_id` (Payment Link ID) and `payment_link_url`.
- Records `ACTION_EXECUTION_STARTED` and `ACTION_EXECUTED` (or `ACTION_EXECUTION_FAILED`) audit events.

## Outcome Reconciliation & Revenue Attribution Rules

The outcome reconciliation engine (`backend/src/services/reconciliationService.js`):
1. **Multi-Strategy Correlation**:
   - Priority 1: Match by Payment Link ID (`action.provider_action_id == event.paymentLinkId`)
   - Priority 2: Match by Reference ID (`action.idempotency_key == event.referenceId`)
   - Priority 3: Match by Case Payment ID / Order ID
2. **Amount and Currency Verification**:
   - Compares provider `amountPaid` vs action `amount` and received `currency` vs expected `currency`.
   - On mismatch: creates `FAILED_MISMATCH` outcome, flags case `REVIEW_REQUIRED`, triggers `RECOVERY_OUTCOME_REJECTED` audit, credits ₹0.
   - On partial payment: creates `PARTIALLY_PAID` outcome, keeps case open, triggers `RECOVERY_OUTCOME_RECEIVED` audit.
   - On exact match: creates verified `PAID` outcome, transitions action to `OUTCOME_CONFIRMED`, resolves case with `recovered_amount = amountPaid`, records `REVENUE_RECOVERED` audit.
3. **Strict Zero Double-Counting**:
   - Unique constraints on `(provider, provider_event_id)` and partial unique index on `recovery_outcomes(recovery_action_id) WHERE verified = true` guarantee at both database and application levels that no event or action is credited twice.

## Tests

```sh
pnpm test
pnpm frontend:build
```

Automated tests (82+ tests) cover webhook verification, normalization, risk detection, AI diagnosis, evidence grounding, policy rules, executor idempotency, outcome reconciliation, correlation strategies, amount/currency integrity checks, double-counting protection, metrics computation, REST endpoints, audit logs, and PostgreSQL persistence.

## Current limitations

- Only `CREATE_PAYMENT_LINK` is enabled as an executable recovery action.
- Only Razorpay Test Mode keys (`rzp_test_...`) are permitted.
- Batch evaluation and the seven domain playbooks are deferred to future milestones.
- No autonomous retries, discounts, refunds, customer SMS/email messaging, or money movement outside Standard Payment Links exists.
