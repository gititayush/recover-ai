# RecoverAI Architecture — Milestones 1 to 5

```mermaid
flowchart TD
  R[Razorpay Test Mode Webhook] --> B[Exact Raw-Body Capture]
  B --> H[HMAC-SHA256 Verification]
  H --> D[Provider Event ID Deduplication]
  D --> N[Payload Normalization]
  N --> E[Canonical POST /api/events Service]
  S[Local Simulator] --> E
  E --> RD[Deterministic Risk Detector]
  RD --> C[RecoveryCase + Audit Trail]
  C --> CT[Minimized Case Context]
  CT --> AI[AI Provider / Development Fallback]
  AI --> V[Strict Schema & Evidence Validation]
  DP[Persisted AI Diagnosis Proposal]
  V --> DP
  DP --> PE[Deterministic Policy Engine]
  PE -->|ALLOW| EX[Bounded Recovery Executor]
  PE -->|REVIEW / BLOCK| AD[Audit Trail & Review Status]
  EX -->|POST /v1/payment_links| RZP[Razorpay Test Mode API]
  RZP -->|Payment Link Created| RA[recovery_actions: EXECUTED + ACTION_EXECUTED Audit]
  RA --> UI[React Operations Dashboard]
  RZP -.->|Customer Pays Link / Webhook: payment_link.paid| OR[Outcome Reconciliation Engine]
  OR -->|Verify ID + Amount + Currency| OC[recovery_outcomes: PAID / verified=true]
  OC -->|Update Action| RC[recovery_actions: OUTCOME_CONFIRMED]
  RC -->|Resolve Case| RCC[recovery_cases: RESOLVED / recovered_amount=X]
  RCC -->|Audit Trail| AT[Audit: RECOVERY_OUTCOME_VERIFIED + REVENUE_RECOVERED]
```

## System Overview

RecoverAI is structured into strictly separated, bounded layers:

1. **Event Ingestion & Normalization**: Authenticates signed Razorpay webhooks (HMAC-SHA256), deduplicates provider event IDs, stores raw payloads, and normalizes events into canonical format.
2. **Risk Detector & Recovery Cases**: Analyzes normalized events, calculates risk levels (`LOW`, `MEDIUM`, `HIGH`), creates or updates `RecoveryCase` records, and maintains an append-only audit log.
3. **AI Diagnosis Proposal Layer (Advisory)**: Receives a minimized context (excluding secrets, raw bodies, and PII), generates structured diagnosis proposals (`CREATE_PAYMENT_LINK`, `REQUEST_MANUAL_REVIEW`, `NO_ACTION`), and enforces strict evidence grounding.
4. **Deterministic Policy Engine (Authoritative)**: Evaluates AI proposals against 12 explicit, reproducible guardrail rules before authorizing any execution.
5. **Bounded Recovery Executor**: Performs authorized recovery actions against Razorpay Test Mode APIs (`CREATE_PAYMENT_LINK`).
6. **Outcome Reconciliation & Truthful Revenue Attribution**: Reconciles executed recovery actions against incoming payment completion events (`payment_link.paid`, `payment.captured`, `order.paid`) to verify amounts and attribute actual recovered revenue without double-counting.

---

## Authority & Execution Model

The system enforces a strict non-negotiable authority model:

```text
AI (Advisory Recommendation)
  ↓
Policy Engine (Authoritative Decision)
  ↓ (ALLOW)
Executor (Bounded Financial Execution)
  ↓
Razorpay Infrastructure (External Payment System: Payment Link Generated)
  ↓
Customer Payment Outcome (Razorpay Webhook)
  ↓
Outcome Reconciliation (Verified Revenue Attribution & Case Resolution)
```

- **AI cannot execute**: The AI layer produces structured proposals only. It has no network client, credentials, or authority to interact with payment gateways.
- **Policy Engine is authoritative**: No controller or endpoint may invoke the executor without a server-side `ALLOW` decision from `evaluatePolicy()`.
- **Executor is isolated**: Only `backend/src/actions/paymentLinkExecutor.js` and `backend/src/services/razorpayClient.js` can call the Razorpay API.
- **Strict Accounting Rule**: Payment Link creation marks `ACTION EXECUTED` (revenue pending). Only a verified outcome webhook marks `OUTCOME_CONFIRMED` and credits `recovered_amount`.

---

## Policy Engine Guardrails (`recoverai-policy-v1`)

The Policy Engine (`backend/src/policy/policyEngine.js`) evaluates 12 deterministic rules for every recovery action request:

| Rule | Name | Condition for BLOCK / REVIEW |
|---|---|---|
| 1 | `terminal_payment` | BLOCK if payment status is `captured`, `paid`, or `refunded`, or `order.status` is `paid`. |
| 2 | `case_status` | BLOCK if case status is `RESOLVED` or `SUPPRESSED`. |
| 3 | `action_allowlist` | BLOCK if action is not `CREATE_PAYMENT_LINK`; REVIEW if action is `REQUEST_MANUAL_REVIEW`. |
| 4 | `confidence_threshold` | REVIEW if AI confidence $< 0.65$. |
| 5 | `max_attempts` | REVIEW if automated recovery attempts $\ge 2$. |
| 6 | `duplicate_action` | BLOCK if an active or executed recovery action already exists for the case. |
| 7 | `amount_integrity` | BLOCK if amount $\le 0$ or invalid. |
| 8 | `high_value_escalation` | REVIEW if amount $> \text{₹}25,000$ ($2,500,000$ paise). |
| 9 | `cooldown_period` | REVIEW if elapsed time since previous attempt $< 30$ minutes. |
| 10 | `context_integrity` | BLOCK if required case fields (`paymentId`, `amount`, `currency`) are missing. |
| 11 | `test_mode_verification` | BLOCK if application is not configured for Razorpay Test Mode (`rzp_test_...`). |
| 12 | `resolved_outcome_check` | BLOCK if payment outcome is resolved or refunded in case history. |

Decision Precedence: `BLOCK` $\succ$ `REVIEW` $\succ$ `ALLOW`.

---

## Outcome Reconciliation Architecture

The reconciliation service (`backend/src/services/reconciliationService.js`) closes the revenue recovery loop:

1. **Correlation Strategies**:
   - `providerActionId` match: matches `payload.payment_link.entity.id` against `recovery_actions.provider_action_id`.
   - `referenceId` match: matches `payload.payment_link.entity.reference_id` against `recovery_actions.idempotency_key`.
   - `paymentId` / `orderId` match: matches `payload.payment.entity.id` or `order_id` against `recovery_cases.payment_id` / `order_id`.
2. **Amount and Currency Integrity**:
   - Compares expected amount from recovery action vs actual provider amount paid.
   - Compares expected currency vs actual provider currency.
   - Rejects mismatches (`outcome = 'FAILED_MISMATCH'`, case marked `REVIEW_REQUIRED`, no money credited).
   - Handles partial payments (`outcome = 'PARTIALLY_PAID'`, case remains open).
3. **Database Constraints for Zero Double-Counting**:
   - `CONSTRAINT recovery_outcomes_provider_event_unique UNIQUE (provider, provider_event_id)`
   - `CREATE UNIQUE INDEX recovery_outcomes_action_verified_idx ON recovery_outcomes (recovery_action_id) WHERE (verified = true)`

---

## Stopped & Deferred Layers

- **Deferred Milestones**: Automated retries, customer SMS/email messaging, refunds, discounts, subscriptions, multi-action orchestration, and batch statistical evaluation are deferred to future milestones.
