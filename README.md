# Revflow — AI Revenue Recovery Control Plane

> **Turn failed payments and other revenue leaks into automatically recovered revenue — with AI reasoning, deterministic financial guardrails, bounded execution, and provider-verified outcomes.**

[![Razorpay Buildathon 2026](https://img.shields.io/badge/Razorpay_Buildathon-Track_03:_AI_Revenue_Recovery-blue.svg)](https://razorpay.com)
[![Tests](https://img.shields.io/badge/Tests-153%2F153%20Passing-brightgreen.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15+-blue.svg)](https://postgresql.org)
[![Razorpay](https://img.shields.io/badge/Razorpay-Test%20Mode-0C2340.svg)](https://razorpay.com)
[![Status](https://img.shields.io/badge/Status-Live%20Demo%20Ready-success.svg)]()

🌐 **Live Demo Application**: [https://revflow.onrender.com](https://revflow.onrender.com)  
📖 **Technical Architecture Guide**: [docs/architecture.md](docs/architecture.md)

---

### The Fundamental Product Principle

```text
       ┌─────────────┐
       │ AI Proposes │ (Advisory hypothesis grounded in payment signals)
       └──────┬──────┘
              ▼
     ┌─────────────────┐
     │ Policy Decides  │ (Authoritative deterministic financial guardrails)
     └────────┬────────┘
              ▼
       ┌─────────────┐
       │Execution Acts│ (Bounded Razorpay Payment Link execution)
       └──────┬──────┘
              ▼
     ┌─────────────────┐
     │Razorpay Verifies│ (Provider-signed webhook with HMAC-SHA256 signature)
     └────────┬────────┘
              ▼
     ┌──────────────────┐
     │Revflow Reconciles│ (Verifies identity, amount, currency & attributes revenue)
     └──────────────────┘
```

> [!IMPORTANT]
> **AI never touches merchant money directly.**  
> In Revflow, AI is strictly advisory. It diagnoses failure context and proposes next-best actions. Only a deterministic, server-side policy engine holds the authority to approve an action. Even then, execution is bounded, fail-closed, and never counted as revenue until confirmed via provider-signed webhook and verified through reconciliation (checking provider identity, exact amount, currency, and action correlation).

---

## What is Working Today

Revflow is not a concept or an ungrounded prompt wrapper. It is a working, tested, and deployed revenue recovery control plane:

- ✅ **3/3 recovery cases resolved** in the current live demonstration batch
- ✅ **₹1,750 revenue recovered** through Razorpay Test Mode workflows
- ✅ **100% verified recovery rate** on the current 3-case test batch
- ✅ **153/153 automated tests passing** across 7 test suites (Vitest)
- ✅ **Live AI diagnosis running in production** with strict Zod schema validation
- ✅ **12 deterministic financial safety guardrails** (`recoverai-policy-v1`)
- ✅ **Bounded Razorpay Payment Link creation** with test mode verification
- ✅ **Provider webhook reconciliation** for `payment_link.paid`, `payment.captured`, and `order.paid`
- ✅ **Multi-strategy correlation** (Payment Link ID → Idempotency Reference → Payment/Order ID)
- ✅ **Mathematical duplicate-action protection** and rate-limiting cooldowns
- ✅ **Fail-closed safety defaults** across AI timeouts, provider errors, and amount discrepancies
- ✅ **Autonomous background recovery worker** with atomic lease claiming and backoff
- ✅ **Payment-scoped deterministic idempotency** that prevents collisions with historical provider entities

> [!NOTE]
> *Note on Demonstration Scope*: The 100% recovery rate cited above refers specifically to the verified 3-case Test Mode demonstration batch. All demonstrated transactions use Razorpay Test Mode keys; no real customer funds are handled or transferred during demonstrations.

> [!IMPORTANT]
> **The Important Distinction: Action Execution $\neq$ Revenue Recovered**  
> Creating a recovery Payment Link is simply initiating an action; it does **not** equal recovered revenue.  
> 
> Revenue is counted only after the complete verification loop closes:  
> **Customer pays → Provider-signed Razorpay webhook → HMAC-SHA256 signature verification → Reconciliation (verifying provider identity, exact amount, currency, and action correlation) → Case RESOLVED.**  
> 
> In the current Test Mode batch, this closed loop produced **₹1,750 verified recovered revenue across 3/3 cases**.

---

## See the Recovery Loop

```text
payment.failed (Webhook Ingestion)
       │
       ▼
Deterministic Risk Assessment (RECOVERABLE / MEDIUM Risk)
       │
       ▼
Recovery Case Created & Persistent Audit Trail Initialized
       │
       ▼
Autonomous Worker Claims Case (Atomic DB Lease Token)
       │
       ▼
AI Diagnosis (Extracts Cause, Category, Confidence, Grounded Evidence)
       │
       ▼
Deterministic Policy Evaluation (12 Rules Evaluated Server-Side → ALLOW)
       │
       ▼
Bounded Execution (Generates Payment Link via Razorpay Test Mode API)
       │
       ▼
Customer Opens Payment Link & Completes Test Payment
       │
       ▼
Razorpay Dispatches payment_link.paid Webhook (HMAC-SHA256 Signed)
       │
       ▼
Outcome Reconciliation Engine (Verifies Provider Identity, Amount, Currency & Action)
       │
       ▼
Case Status: RESOLVED | Revenue Recovered Credited to Ledger
```

In production, **Case #3** (₹750) was processed through this exact loop autonomously: failed payment ingested → AI diagnosed → policy evaluated `ALLOW` → Razorpay Payment Link generated → customer paid in Test Mode → webhook verified → case marked `RESOLVED`.

---

## The Business Problem

When a customer's payment fails at checkout, during subscription renewal, or against a B2B invoice, most payment infrastructure does exactly one thing: **it logs an error code and stops.**

Merchants face massive revenue leakage across four silent failure modes:
1. **Transient Gateway & Network Drops**: Card networks or banking switches timeout during peak hours, abandoning high-intent buyers who would have paid if offered a direct fallback link.
2. **Checkout Hesitation & Drop-Off**: Customers encounter friction or 3D-Secure failures and abandon cart without an automated, low-friction recovery path.
3. **Recurring & Subscription Friction**: Automated subscription charges fail due to card limits or maintenance windows, leading to involuntary churn.
4. **Unpaid B2B Invoices**: Manual collections workflows are slow, expensive, and lack context-aware follow-ups.

> **"Most payment systems tell a merchant that something failed. Revflow is designed to decide what should happen next, act within strict financial boundaries, and verify whether the intervention actually recovered money."**

---

## Why an AI Agent? (And Why AI Needs Guardrails)

### Why Blind Retry Scripts Fail
Traditional recovery relies on rigid cron jobs or naive retry rules (e.g., *"retry every 4 hours"*):
- They **retry terminal errors** (e.g., stolen cards or cancelled orders), creating bank fees and merchant penalties.
- They **ignore context**: A ₹50,000 corporate purchase requires fundamentally different handling than a ₹200 recurring charge.
- They **cannot adapt**: A failure caused by a temporary acquirer degradation requires an instant alternative payment link, whereas an authentication drop requires customer communication.

### Where AI Excels
An AI reasoning engine excels at synthesizing unstructured failure signals into actionable diagnosis:
- Normalizing messy gateway error descriptions, retry counts, timing context, and order status.
- Classifying failure archetypes (`TRANSIENT_PAYMENT_FAILURE`, `CHECKOUT_DROPOFF`, `MANDATE_TIMING`).
- Grounding diagnoses strictly in observed facts to eliminate hallucinations.
- Proposing the optimal recovery playbook and contextual customer messaging.

### Why Unrestricted AI is Dangerous in Fintech
An LLM must **never** be given raw API keys or unrestricted execution authority in financial workflows:
- LLMs can hallucinate amounts, duplicate operations, or bypass business logic.
- Non-deterministic outputs can trigger unexpected financial liabilities.
- **Revflow's solution**: The AI is strictly an **advisory diagnostician**. A deterministic policy engine sits between the AI and the payment gateway, acting as an unbypasable firewall.

---

## System Architecture

```mermaid
flowchart TD
    subgraph INGESTION ["1. Ingestion & Normalization"]
        WE[Razorpay Webhook: payment.failed] --> H[HMAC-SHA256 Signature Verify]
        H --> DEDUP[Provider Event ID Deduplication]
        DEDUP --> NORM[Normalized Event Canonical Format]
    end

    subgraph RISK ["2. Risk Engine & Case Management"]
        NORM --> DET[Deterministic Risk Detector]
        DET --> RC[(PostgreSQL: Recovery Cases)]
        RC --> AUD[(Append-Only Audit Trail)]
    end

    subgraph AI_LAYER ["3. AI Advisory Diagnosis"]
        RC --> CTX[Minimized Fact-Only Context]
        CTX --> LLM[AI Provider / Gemini / Fallback]
        LLM --> ZOD[Zod Schema & Evidence Field Validation]
        ZOD --> DIAG[(Persisted Diagnosis Proposal)]
    end

    subgraph POLICY ["4. Deterministic Financial Guardrails"]
        DIAG --> POL[Policy Engine: 12 Safety Rules]
        POL -->|BLOCK or REVIEW| ESC[Escalate to Human Review / Halt]
    end

    subgraph EXECUTION ["5. Bounded Execution"]
        POL -->|ALLOW| EXEC[Payment Link Executor]
        EXEC --> IDEMP[Deterministic Reference rc_id_paymentId_v1]
        IDEMP --> RZP_API[Razorpay Test Mode API]
        RZP_API --> ACT[(recovery_actions: EXECUTED)]
    end

    subgraph RECONCILIATION ["6. Provider Verification & Ledger"]
        RZP_API -.->|Customer Pays| PAID_HOOK[Razorpay Webhook: payment_link.paid]
        PAID_HOOK --> RECON[Reconciliation Engine]
        RECON -->|Verify Amount + Currency + Provider ID| CONF[(recovery_outcomes: VERIFIED)]
        CONF --> RESOLVE[Case Status: RESOLVED]
        CONF --> LEDGER[Credited to Recovered Revenue Ledger]
    end

    ESC --> AUD
    ACT --> AUD
    RESOLVE --> AUD
```

### Separation of Responsibilities

| Component | Responsibility | Authority Level | Can Move Money? |
| :--- | :--- | :--- | :---: |
| **AI Diagnosis** | Analyzes failure signals, extracts cause, proposes action | Advisory | ❌ No |
| **Policy Engine** | Evaluates 12 deterministic rules, limits, and cooldowns | Authoritative | ❌ No |
| **Recovery Executor** | Calls Razorpay API with idempotent payment-scoped reference | Bounded | ⚠️ Links Only |
| **Razorpay Provider** | Processes actual payment, signs webhook event | External Source of Truth | ✅ Yes |
| **Reconciliation Engine** | Verifies provider identity, amount, currency, and action correlation | Ledger Authority | ❌ Credits Only |

---

## AI Diagnosis & Strict Schema Validation

Revflow's diagnosis engine inspects failure context and outputs structured JSON strictly validated via Zod (`backend/src/ai/diagnosisSchema.js`).

### Enforced Constraints
- **13 Allowed Evidence Fields**: Evidence must reference exact system vocabulary (`payment.status`, `payment.failureReason`, `case.amount`, `order.status`, etc.).
- **Constrained Categories**: Must fall into defined archetypes (`TRANSIENT_PAYMENT_FAILURE`, `CHECKOUT_DROPOFF`, `FAILED_SUBSCRIPTION`, `B2B_APPROVAL_DELAY`, etc.).
- **Confidence Scoring**: Confidence is a float $\in [0, 1]$. If confidence falls below 0.65, policy automatically halts automated execution and demands human review.
- **Zero Execution Authority**: Recommendation specifies an action identifier (`CREATE_PAYMENT_LINK`), but the AI possesses no network client or credentials.

### Representative Diagnosis Proposal (Example)
```json
{
  "diagnosis": {
    "category": "TRANSIENT_PAYMENT_FAILURE",
    "cause": "Upstream bank switch timed out during payment authorization.",
    "confidence": 0.88,
    "evidence": [
      { "field": "payment.status", "value": "failed" },
      { "field": "payment.failureReason", "value": "Payment processing timed out at acquirer" },
      { "field": "case.amount", "value": "50000" }
    ]
  },
  "recommendation": {
    "action": "CREATE_PAYMENT_LINK"
  }
}
```

---

## Policy Engine & Financial Safety (The 12 Guardrails)

The server-side policy engine (`backend/src/policy/policyEngine.js`, version `recoverai-policy-v1`) independently evaluates 12 rules before any recovery action can execute.

```text
Decision Precedence: BLOCK  ≻  REVIEW  ≻  ALLOW
```

| Rule | Policy Name | Guardrail Logic & Rationale | Action on Trigger |
| :---: | :--- | :--- | :---: |
| **1** | `context_integrity` | Rejects execution if `paymentId`, `amount`, or `currency` is missing or corrupted. | `BLOCK` |
| **2** | `amount_integrity` | Verifies amount $> 0$ and valid integer paise. AI cannot modify amounts. | `BLOCK` |
| **3** | `test_mode_verification` | Verifies credentials start with `rzp_test_`. Live API keys are hard-blocked. | `BLOCK` |
| **4** | `terminal_payment` | Blocks execution if original payment was already captured, settled, or refunded. | `BLOCK` |
| **5** | `case_status` | Halts execution if the case has already transitioned to `RESOLVED` or `SUPPRESSED`. | `BLOCK` |
| **6** | `resolved_outcome_check`| Halts execution if payment outcome was already satisfied in event history. | `BLOCK` |
| **7** | `action_allowlist` | Ensures only explicitly authorized actions (`CREATE_PAYMENT_LINK`) can run. | `BLOCK` |
| **8** | `confidence_threshold` | Demands human oversight if AI diagnosis confidence is below 0.65. | `REVIEW` |
| **9** | `max_attempts` | Caps automated recovery at 2 attempts per case to prevent customer harassment. | `REVIEW` |
| **10** | `duplicate_action` | Blocks execution if an active payment link already exists for this case. | `BLOCK` |
| **11** | `high_value_escalation` | Cases exceeding ₹25,000 ($2,500,000$ paise) require explicit human sign-off. | `REVIEW` |
| **12** | `cooldown_period` | Enforces a mandatory 30-minute quiet period between automated attempts. | `REVIEW` |

### Fail-Closed Principle
If the AI provider times out, returns HTTP 429, produces malformed JSON, fails Zod parsing, or proposes an ungrounded action, **Revflow fails closed**: execution stops immediately, an audit log is written, and the case escalates to human review. The system never guesses.

---

## Real-World Engineering: Provider Idempotency & Database Lifecycles

During live deployment testing, Revflow uncovered a critical real-world edge case in fintech agent architectures:

### The Bug
1. Recovery references were initially generated as `razorpay_case_{caseId}_plink_v{attempt}` (e.g., `razorpay_case_2_plink_v1`).
2. When the PostgreSQL database was re-seeded during a deployment cycle, auto-increment case IDs reset (`1, 2, 3...`).
3. In Razorpay Test Mode, Payment Links created days prior **persisted permanently** in the merchant account under those references.
4. When Case #2 (₹500 / 50000 paise) executed, Revflow queried Razorpay for existing links under `razorpay_case_2_plink_v1` and found a historical test link from 3 days prior created for ₹100 (10000 paise).
5. The policy engine flagged an amount discrepancy (`Amount: 10000 vs 50000`) and blocked execution.

### The Fix: Payment-Scoped Deterministic References
Revflow updated its reference generation to tie directly to the unique failed payment identifier:

```javascript
function buildStableReferenceId(recoveryCase, attemptNumber = 1) {
  const rawPaymentId = String(recoveryCase?.paymentId || `case_${recoveryCase?.id || 'unknown'}`);
  const sanitized = rawPaymentId.replace(/[^a-zA-Z0-9_-]/g, '');
  const prefix = `rc_${recoveryCase?.id || 0}_`;
  const suffix = `_v${attemptNumber}`;
  const maxTokenLen = 40 - prefix.length - suffix.length;
  const paymentToken = sanitized.length > maxTokenLen ? sanitized.slice(-maxTokenLen) : sanitized;
  return `${prefix}${paymentToken}${suffix}`;
}
```

- **Example Output**: `rc_2_pay_TXHXFLRWrIcSRC_v1` (26 characters).
- **Guaranteed Boundedness**: Mathematically capped at $\le 40$ characters (Razorpay's API limit).
- **Deterministic & Zero-Randomness**: Retries of the same case attempt compute the exact same string, ensuring safe deduplication and race-recovery adoption without UUID drift.
- **Provider Isolation**: Database sequence resets can never collide with historical payment links.

---

## Autonomous Recovery Worker

Revflow includes an autonomous background recovery worker (`backend/src/worker/recoveryWorker.js`) that operates alongside the API:

1. **Polling & Atomic Leases**: Polls PostgreSQL for cases in `QUEUED` or `RETRY_SCHEDULED` status using atomic database transactions with lease tokens (`locked_until`, `locked_by`).
2. **Crash & Restart Resilience**: If the worker process restarts mid-flight, expired leases are automatically reclaimed by subsequent worker loops.
3. **Execution Guard**: Re-checks policy and provider state immediately prior to external execution to prevent Time-of-Check to Time-of-Use (TOCTOU) race conditions.
4. **Idempotent Adoption**: If Razorpay returns HTTP 400 (`reference_id already exists`), the worker queries the provider, validates amount and currency, and adopts the existing link rather than crashing.

---

## Truthful Revenue Attribution & Reconciliation

In Revflow, **creating a Payment Link does NOT count as recovered revenue.**

```text
Action Executed (Payment Link Created)  ≠  Revenue Recovered
```

### The 5-Step Verification Process
1. Customer accesses the Razorpay payment URL and completes payment.
2. Razorpay signs and dispatches a `payment_link.paid` or `payment.captured` webhook.
3. Revflow verifies the provider-signed webhook's HMAC-SHA256 signature using `RAZORPAY_WEBHOOK_SECRET`.
4. The reconciliation engine executes multi-strategy correlation:
   - **Priority 1**: Match by Payment Link ID (`provider_action_id == event.paymentLinkId`).
   - **Priority 2**: Match by Reference ID (`idempotency_key == event.referenceId`).
   - **Priority 3**: Match by Case Payment ID / Order ID.
5. Exact amount and currency integrity check:
   - **Mismatch**: Flagged as `FAILED_MISMATCH`, escalated to human review, credited ₹0.
   - **Partial**: Recorded as `PARTIALLY_PAID`, case remains open, credited partial amount.
   - **Exact Match**: Marked `OUTCOME_CONFIRMED`, case marked `RESOLVED`, full amount credited to `recovered_amount`.

Zero double-counting is enforced via database unique constraints on `(provider, provider_event_id)` and a partial unique index on `recovery_outcomes(recovery_action_id) WHERE verified = true`.

---

## Current Demonstration Results

The following table summarizes verified outcomes from the live deployment batch on Render:

| Case ID | Case Amount | Failure Reason | AI Diagnosis | Policy Decision | Recovery Action | Razorpay Outcome | Final Case State |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **Case #1** | ₹500 | `Payment failed` | Transient failure | `ALLOW` (12/12 PASS) | Payment Link Created | ✅ Verified Paid | `RESOLVED` |
| **Case #2** | ₹500 | `Payment failed` | Transient failure | `ALLOW` (12/12 PASS) | Payment Link Created | ✅ Verified Paid | `RESOLVED` |
| **Case #3** | ₹750 | `Bank switch timeout` | Transient failure | `ALLOW` (12/12 PASS) | Payment Link Created | ✅ Verified Paid | `RESOLVED` |

- **Total Batch Revenue at Risk**: ₹1,750
- **Total Verified Revenue Recovered**: ₹1,750 (175,000 paise)
- **Batch Recovery Rate**: 100% (3 of 3 cases resolved)

---

## What Happens When Things Break?

Revflow was architected specifically around failure modes. The table below illustrates how the system handles adverse conditions:

| Scenario / Failure Condition | System Behavior | Safety Outcome |
| :--- | :--- | :--- |
| **AI Provider Outage / HTTP 404 / 429** | Catches upstream provider error, logs audit event, halts automated execution. | Case marked `AUTONOMY_REVIEW_REQUIRED`; zero unsafe calls made. |
| **Malformed AI Output / Schema Violation** | Zod rejects payload; logs specific field errors and truncated input values. | Action blocked; fail-closed execution prevents invalid parameters. |
| **Provider Amount or Currency Mismatch** | Compares provider link amount against case amount; mismatch throws 422. | Action halted; `ACTION_REVIEW_REQUIRED` audit generated. |
| **Concurrent Action Race** | Database unique constraint and active duplicate policy rule check in-flight actions. | Second attempt blocked; duplicate payment link creation prevented. |
| **Terminal or Refunded Payment** | Policy Rule 1 (`terminal_payment`) and Rule 12 inspect event history. | Action hard-blocked; prevents re-charging customer for settled order. |
| **High-Value Transaction (> ₹25,000)** | Policy Rule 8 evaluates amount in paise against threshold. | Action routed to human review; automated financial execution blocked. |

---

## V1 → V2 Roadmap: From Payment Recovery to Autonomous Revenue Operations

> [!NOTE]
> *Status Disclosure*: Features below represent the planned V2 architecture designed to scale Revflow from a payment-link recovery engine into a comprehensive autonomous revenue recovery platform. None of the V2 roadmap items below should be understood as currently implemented in production; they reflect our planned technical milestones.

```mermaid
mindmap
  root((Revflow V2))
    Decision Intelligence
      Next-Best-Action NBA Engine
      Expected Recovery Value Scoring
      Dynamic Multi-Channel Routing
    Autonomous Lifecycle
      Explicit Stopping Criteria
      Customer-Aware Recovery
      Automated Cooldown Tuning
    Expanded Playbooks
      Checkout Drop-Off Recovery
      Failed Subscription Dunning
      B2B Receivables Chaser
      Mandate Retry Sequencer
    Observability & Safety
      Adversarial Safety Evaluation
      Continuous Outcome Learning
      Enterprise Command Center
```

### 1. Next-Best-Action (NBA) Engine
- Evaluate and rank candidate recovery actions (`CREATE_PAYMENT_LINK`, `SCHEDULE_RETRY_WINDOW`, `SEND_WHATSAPP_REMINDER`, `ESCALATE_TO_ACCOUNT_MANAGER`, `NO_ACTION`) based on Expected Recovery Value ($ERV = \text{Amount} \times P(\text{Recovery}) - \text{Friction Cost}$).

### 2. Explicit Explainable Stopping Criteria
- Formally stop recovery workflows when:
  - Customer completes payment externally
  - Maximum recovery attempts or economic cost thresholds are reached
  - Customer opts out or expresses negative sentiment
  - Case enters a terminal or refunded state
  - Every stop decision produces an immutable, explainable audit record

### 3. Tiered Human Escalation (`HUMAN_APPROVAL_REQUIRED`)
- High-value recoveries (> ₹25,000)
- Low-confidence AI diagnoses ($< 0.65$)
- Multi-attempt failure sequences
- Detected regulatory or policy anomalies

### 4. High-Throughput Batch Recovery
- Ingest, group, and evaluate hundreds of at-risk transactions concurrently.
- Portfolio-level risk modeling and aggregate financial exposure controls.

### 5. Checkout Drop-Off Recovery
- Intercept cart abandonment and authentication hesitation with pre-filled, cart-contextual checkout links.

### 6. Subscription & Recurring Dunning
- Smart retry scheduling aligned with customer salary cycles (1st–5th of the month) to minimize involuntary subscription churn.

### 7. B2B Receivables & Overdue Invoices
- Structured chasing workflows for corporate accounts with payment terms ($Net\ 30 / 60$), approval delay detection, and automated reconciliation.

### 8. Contextual Multilingual Recovery (English / Hindi / Hinglish)
- Generate culturally fluent, localized WhatsApp and email reminder copy tailored to customer payment history and regional language preferences.

### 9. Outcome Learning & Recovery Intelligence
- Offline evaluation loops that track recovery success by strategy, payment method, bank code, and time of day, continuously refining confidence scores.

### 10. Adversarial Financial Safety Test Suite
- Automated synthetic testing simulating malicious webhooks, currency manipulation, replay attacks, and clock skew to verify safety guardrails.

---

## Alignment with Razorpay's Agentic Vision

Revflow is built around the same vision pioneered by Razorpay: **transitioning financial operations from reactive dashboards to intelligent, autonomous agentic systems.**

- **From Logging to Acting**: Shifting from passive error reporting to autonomous, bounded intervention.
- **Deep Razorpay Integration**: Native alignment with Razorpay Payment Links, Webhooks, and standard checkout paradigms.
- **Merchant Sovereignty**: Autonomous execution strictly constrained by merchant-defined policy guardrails.

> *Disclaimer: Revflow is an independent project created for the Razorpay Buildathon 2026. It is inspired by and architecturally aligned with Razorpay's agentic payments direction, but is not an official Razorpay product.*

---

## Technology Stack

### Core Architecture
- **Runtime**: Node.js (v20+ LTS)
- **Web Framework**: Express 5
- **Database**: PostgreSQL 15+ (pg connection pooling)
- **Frontend**: React 19, Vite, Vanilla CSS Operations Dashboard
- **Payment Gateway**: Razorpay Test Mode REST API & Webhook Infrastructure
- **AI Diagnostics**: Google Gemini / OpenAI-compatible LLM endpoints

### Engineering & Reliability
- **Schema Validation**: Zod (Strict schema validation for inputs, webhooks, and AI outputs)
- **Policy Engine**: In-memory deterministic rule engine with configurable thresholds
- **Worker**: Persistent autonomous background worker with atomic DB lease tokens
- **Testing**: Vitest, Supertest (153 unit, integration, and end-to-end tests)
- **Security**: HMAC-SHA256 signature verification, fail-closed design, credential separation

---

## Running Locally

### Prerequisites
- **Node.js**: `v20.0.0` or later
- **PostgreSQL**: `v15.0` or later
- **Package Manager**: `pnpm` (`npm install -g pnpm`)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/gititayush/recover-ai.git
cd recover-ai
pnpm install
pnpm --dir frontend install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure the following variables in `.env`:

| Variable Name | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` | Backend HTTP port | `3001` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:password@localhost:5432/recoverai` |
| `NODE_ENV` | Application environment | `development` |
| `RAZORPAY_KEY_ID` | Razorpay Test Mode Key ID | `rzp_test_...` |
| `RAZORPAY_KEY_SECRET` | Razorpay Test Mode Key Secret | *Test Secret* |
| `RAZORPAY_WEBHOOK_SECRET`| Razorpay Webhook Secret | *Webhook Secret* |
| `AI_PROVIDER` | AI provider protocol | `openai-compatible` |
| `AI_MODEL` | AI model identifier | `gemini-2.5-flash` or `gpt-4.1-mini` |
| `AI_API_KEY` | Upstream AI API key | *API Key* |
| `AI_BASE_URL` | AI endpoint base URL | *Provider Base URL* |
| `AUTONOMOUS_RECOVERY_ENABLED` | Toggle background autonomous worker | `true` |

### 3. Run Database Migrations
```bash
pnpm db:migrate
```

### 4. Start the Application
In separate terminal windows:
```bash
# Terminal 1: Backend API & Recovery Worker
pnpm start

# Terminal 2: React Operations Dashboard
pnpm frontend
```

The backend starts at `http://localhost:3001`; the frontend dashboard opens at `http://localhost:5173`.

### 5. Replay Razorpay Webhook Fixtures
Simulate verified Razorpay webhook events locally with HMAC-SHA256 webhook signature verification:
```bash
pnpm replay:razorpay
```

---

## Test Suite Execution

Run the complete automated test suite:

```bash
pnpm test
```

### Test Suite Coverage
```text
 Test Files  7 passed (7)
      Tests  153 passed (153)
   Duration  2.98s
```

The 153 tests thoroughly validate:
- Razorpay HMAC-SHA256 webhook authentication & deduplication
- Deterministic risk assessment and case creation
- Zod schema validation and constrained evidence vocabulary
- All 12 deterministic policy rules and edge conditions
- Payment-scoped idempotency key generation and provider isolation
- Multi-strategy outcome reconciliation and zero double-counting
- Autonomous worker atomic leasing, retries, and backoff
- High-value human escalation triggers and cooldown enforcement

---

## 5-Minute Evaluation Walkthrough

Follow these steps to experience Revflow end-to-end:

1. **Inspect an At-Risk Case**: Open the dashboard at [https://revflow.onrender.com](https://revflow.onrender.com) and click **Case #1** or **Case #2**.
2. **Review the AI Diagnosis**: Inspect the structured diagnosis proposal, observing the specific cause, confidence rating, and grounded evidence facts.
3. **Inspect the 12 Guardrails**: Observe the real-time evaluation card showing all 12 policy safety checks passing server-side.
4. **Execute Recovery**: Click **EXECUTE RECOVERY ACTION**. Observe the bounded executor call Razorpay and receive a verified Test Mode Payment Link.
5. **Simulate Payment**: Open the generated Razorpay payment link in test mode and simulate a successful payment.
6. **Observe Verified Reconciliation**: Watch the webhook reconcile the case in real time: action status transitions to `OUTCOME_CONFIRMED`, case status updates to `RESOLVED`, and recovered revenue is credited to the ledger.

---

## Engineering Lessons from Development

Building a financial recovery agent in production revealed critical distributed systems lessons:

1. **AI Must Be Purely Advisory**: Allowing an LLM to directly invoke external banking APIs is an unacceptable financial risk. Strict separation between *reasoning* (AI) and *authority* (Policy) is mandatory.
2. **Action Execution $\neq$ Recovered Revenue**: A payment link is an unfulfilled intent. Financial metrics must only acknowledge revenue when the provider emits a verified completion webhook.
3. **Database Sequence Drift vs. Provider Persistence**: Auto-increment database IDs (`Case #1`) reset upon database re-creation, but external payment gateways remember every historical entity. Recovery references must incorporate immutable transaction identifiers (`paymentId`) to guarantee provider-level uniqueness.
4. **Fail-Closed Architecture is Essential**: When external AI providers experience upstream latency or rate limits, the agent must cleanly pause, log an audit event, and escalate to human review rather than guessing or crashing.

---

## Why Revflow?

| Dimension | Traditional Naive Dunning | Generic AI Chatbot | Revflow Control Plane |
| :--- | :--- | :--- | :--- |
| **Trigger** | Periodic blind timer | Ad-hoc user prompt | Real-time payment event stream |
| **Reasoning** | None (fixed retry rules) | Unconstrained generation | Structured, evidence-grounded AI |
| **Safety** | Static logic | Hallucination risk | **12 Deterministic Financial Guardrails** |
| **Authority** | Blind execution | No execution capability | **Separated: AI proposes, Policy decides** |
| **Accounting** | Assumes intent = success | Unaware of ledger | **Provider-signed webhook & verified reconciliation (identity, amount, currency, action)** |
| **Failure Mode** | Spam & bank penalties | Financial liability | **Fail-closed with human escalation** |

---

## Summary

Revenue recovery should not end at detecting a failed payment.

Revflow closes the loop:
- **Detect** the revenue leak in real time.
- **Diagnose** the root cause with grounded AI reasoning.
- **Decide** within 12 unbypasable financial guardrails.
- **Recover** via bounded Razorpay Test Mode execution.
- **Verify** through provider-signed webhooks with HMAC-SHA256 signatures.
- **Reconcile** provider identity, amount, currency, and action correlation to attribute truthful revenue without double-counting.

That is the foundation of an autonomous revenue recovery control plane.

---

**Live Demonstration**: [https://revflow.onrender.com](https://revflow.onrender.com)  
**Project Repository**: [https://github.com/gititayush/recover-ai](https://github.com/gititayush/recover-ai)
