# Revflow — Autonomous AI Revenue-Recovery Control Plane

> **Revflow transforms payment failures from passive error logs into an autonomous, bounded recovery control plane: ingesting provider telemetry, classifying root causes through grounded failure intelligence, synthesizing candidate recovery strategies, enforcing deterministic financial policy, executing bounded interventions via Razorpay, obtaining external provider verification, and reconciling ledgers without double-counting.**

[![Razorpay Buildathon 2026](https://img.shields.io/badge/Razorpay_Buildathon-Track_03:_AI_Revenue_Recovery-blue.svg)](https://razorpay.com)
[![Tests](https://img.shields.io/badge/Tests-566%2F566%20Passing-brightgreen.svg)]()
[![Suites](https://img.shields.io/badge/Suites-28%20Passing-brightgreen.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15+-blue.svg)](https://postgresql.org)
[![Razorpay](https://img.shields.io/badge/Razorpay-Test%20Mode-0C2340.svg)](https://razorpay.com)
[![Status](https://img.shields.io/badge/Status-Demo%20Ready-success.svg)]()

🌐 **Live Production Deployment**: [https://revflow.onrender.com](https://revflow.onrender.com)
📦 **Repository**: [https://github.com/gititayush/recover-ai](https://github.com/gititayush/recover-ai)

---

## Overview

In modern internet commerce, when a payment fails at checkout, during a recurring subscription debit, or against a commercial B2B invoice, payment infrastructure typically logs an error code and drops the customer. Merchants suffer compounding revenue leakage from transient gateway errors, authentication timeouts, and involuntary churn—even though many of these buyers maintain high purchase intent and would readily pay through an alternative channel or direct link.

A failed payment does not necessarily mean permanently lost revenue. However, recovering revenue safely requires solving two fundamentally distinct problems:
1. **Understanding why a payment failed**: extracting cryptic provider signals, diagnosing technical root causes, and distinguishing transient hiccups from hard terminal rejections.
2. **Safely attempting and confirming a recovery**: evaluating intervention strategies, enforcing financial guardrails, executing bounded actions, and verifying actual payment capture before crediting the ledger.

Revflow addresses both challenges through an **autonomous, policy-gated recovery control plane**. AI is used where it excels—interpreting unstructured telemetry, discovering unknown factors, translating technical codes into actionable explanations, and proposing candidate recovery actions. Deterministic software controls everything else: financial calculations, policy invariants, stopping criteria, external provider execution, and cryptographic ledger reconciliation.

```text
┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌───────────────────┐     ┌────────────────────┐
│   AI Proposes  │ ──> │ Policy Decides │ ──> │  Executor Acts │ ──> │ Provider Verifies │ ──> │ Revflow Reconciles │
└────────────────┘     └────────────────┘     └────────────────┘     └───────────────────┘     └────────────────────┘
  (Advisory              (Authoritative         (Bounded Link or       (External Signed          (Verifies Exact
   Inference)             Guardrails)            Simulated Action)      Provider Webhook)         Amount & Ledger)
```

---

## The Problem

Every year, digital merchants lose billions to failed payments that should have succeeded:

- **Transient Gateway & Bank Switch Drops**: Upstream issuer switch timeouts and network congestion abandon high-intent buyers during checkout peaks.
- **Authentication & 3DS Friction**: Customers abandon transactions due to delayed OTP delivery or ambiguous verification errors without an alternate payment path.
- **Involuntary Subscription Churn**: Recurring mandate debits fail due to temporary account balance timing or issuer maintenance windows, cancelling active accounts.
- **Aged B2B Receivables**: Invoices drift past agreed commercial payment terms because finance teams lack automated, terms-aware recovery workflows.

Traditional payment gateways simply report `payment.failed` to an error log. The merchant's engineering team is left to manually triage failures or write brittle cron jobs that risk customer harassment, duplicate charges, or double-counted revenue.

---

## The Solution

Revflow converts payment failures into an active, deterministic recovery workflow. When a transaction fails, Revflow:

1. Ingests raw provider telemetry and extracts immutable facts into an append-only event log.
2. Applies a **Three-Layer Failure Intelligence Engine** that deterministically classifies errors into canonical taxonomy families while using advisory AI for root-cause synthesis.
3. Computes **Expected Recovery Value (ERV)** across candidate strategies to identify the optimal intervention.
4. Enforces **12 Invariant Deterministic Policy Rules** and an explicit **Stopping Engine** (`BLOCK ≻ REVIEW ≻ ALLOW`).
5. Executes bounded interventions—generating an idempotent **Razorpay Test Mode Payment Link** for external settlement.
6. Listens for provider-signed webhooks (`payment_link.paid`), validates HMAC-SHA256 signatures, and executes multi-key reconciliation before marking revenue as recovered.

---

## End-to-End Recovery Pipeline

Revflow structures every recovery opportunity through eight strictly separated lifecycle stages:

```mermaid
flowchart TD
    A[1. Provider Telemetry\nRaw Gateway Event / Failure Signal] --> B[2. Failure Intelligence\nFact Extraction & Signature Generation]
    B --> C[3. AI Diagnosis\nContextual Synthesis & Root-Cause Analysis]
    C --> D[4. Recovery Strategy\nCandidate Generation & ERV Scoring]
    D --> E[5. Policy Governance\n12 Invariant Rules & Stopping Engine]
    E -->|BLOCK / REVIEW| F[Escalation / Abstention\nHuman Operations Review Gate]
    E -->|ALLOW| G[6. Bounded Execution\nIdempotent Razorpay Payment Link]
    G --> H[Customer Settlement\nBuyer Completes Payment via Link]
    H --> I[7. Provider Confirmation\nSigned Razorpay Webhook Ingestion]
    I --> J[8. Ledger Reconciliation\nMulti-Key Verification & Revenue Credited]
```

### 1. Provider Telemetry
Raw payment failure events enter the system via webhook ingestion or direct event ingestion (`POST /api/events`). The system captures payment identifiers, order identifiers, error codes (`error_code`), error sources (`error_source`), error steps (`error_step`), failure descriptions (`error_description`), payment methods, attempt counts, and timestamps without synthetic modification.

### 2. Failure Intelligence
Revflow processes raw telemetry through a deterministic fact extractor that computes evidence strength (`STRONG`, `PARTIAL`, `MINIMAL`, `NONE`) and generates an immutable `failureSignature` (e.g., `bank|payment_authorization|bad_request_error`).

### 3. AI Diagnosis
The context builder compiles verified provider facts, customer history, and playbook metadata into a structured prompt. The AI service synthesizes a contextual diagnosis with calibrated confidence and explicit unknowns. A mandatory safety guard validates that every cited classification basis key actually exists in the provider facts, capping confidence at $\le 0.35$ and enforcing `UNKNOWN_FAILURE` whenever provider telemetry is generic.

### 4. Recovery Strategy
The system evaluates all candidate interventions registered for the active business domain. Strategies are ranked using Expected Recovery Value (ERV):
$$\text{ERV} = (\text{Amount} \times P(\text{Recovery})) - \text{Intervention Cost} - \text{Friction Penalty}$$
The highest-ranked strategy is nominated for execution.

### 5. Policy Governance
Before any action can execute, Revflow passes the proposal through 12 deterministic policy rules and an explicit stopping engine. If any hard invariant is violated, the action is marked `BLOCK`. If ambiguity, low confidence, or high monetary value is detected, it is routed to `REVIEW` for human operator approval. **Human approval can resolve a review gate, but can never override a block.**

### 6. Bounded Execution
Once policy returns `ALLOW`, the executor creates an external action. For live financial actions, Revflow generates an idempotent Razorpay Test Mode Payment Link with a deterministic reference ID, server-owned integer amount, and strict customer notifications disabled.

### 7. Provider Confirmation
Executing an action does **not** credit recovered revenue. Revflow waits for external settlement. When the customer pays, Razorpay fires a `payment_link.paid` or `payment.captured` webhook to `/api/webhooks/razorpay`. Revflow cryptographically verifies the payload using HMAC-SHA256.

### 8. Reconciliation
The reconciliation service performs four-point verification:
- Provider Payment Link ID match
- Payment reference ID correlation
- Exact amount match in integer paise (`amount_expected == amount_paid`)
- Currency match (`INR`)

Only upon passing all checks does the case transition to `RESOLVED`, crediting `recovered_amount` to the merchant ledger.

---

## AI / Agent Design

Revflow implements a disciplined separation between probabilistic AI reasoning and deterministic financial execution.

```text
┌──────────────────────────────────────────────┐
│               INCOMING SIGNALS               │
└──────────────────────┬───────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌──────────────────────────────┐┌──────────────────────────────┐
│       WHERE AI IS USED       ││ WHERE DETERMINISTIC RULES WIN│
│     (Advisory Reasoning)     ││   (Authoritative Governance) │
├──────────────────────────────┤├──────────────────────────────┤
│ • Contextual Synthesis       ││ • Provider Fact Extraction   │
│ • Cryptic Error Translation  ││ • Financial Calculations (₹) │
│ • Unknowns Discovery         ││ • Canonical Safety Bounds    │
│ • Root-Cause Explanations    ││ • Policy Rules (12 Invariants│
│ • Next-Best-Action Rationale ││ • Stopping Engine (HARD_STOP)│
│ • Multilingual Copy Creation ││ • Provider Verification      │
│   (English, Hindi, Hinglish) ││ • Ledger Reconciliation      │
└──────────────────────────────┘└──────────────────────────────┘
```

### Information Supplied to the AI
The AI model receives only verified server-side context facts:
- Event metadata: `eventType`, `occurredAt`, `attemptCount`
- Provider diagnostic facts: `error_code`, `error_source`, `error_step`, `error_description`, `error_reason`
- Transaction parameters: `amount` (formatted string for display), `currency`, `paymentMethod`
- Playbook context: domain type (`payment_degradation`, `checkout_drop_off`, `failed_subscription`, `b2b_receivables`)

### Strict AI Boundaries
- **Zero Monetary Authority**: The LLM cannot specify, alter, or round recovery amounts. All amounts are integer paise derived directly from verified database records.
- **No Direct Tool/API Access**: The LLM cannot call external APIs, generate payment links, issue refunds, or modify case state directly. It returns structured advisory JSON.
- **Zod Schema Enforcement**: All AI responses must validate against strict Zod schemas (`diagnosisSchema.js`). If schema validation fails, Revflow falls back safely without executing unauthorized actions.
- **Conservative Abstention Guard**: If the gateway reports only generic text (e.g., `"Payment failed"`), `guardFailureClassification` overrides any hallucinated technical diagnosis, forcing `UNKNOWN_FAILURE` with confidence $\le 0.35$ and an explicit checklist of unverified factors.

---

## Failure Taxonomy

Revflow's Three-Layer Failure Intelligence Engine categorizes payment failures into **12 Canonical Failure Families**:

| Failure Family | What It Represents | Identifying Evidence | Recoverability | Recommended Recovery Behavior |
| :--- | :--- | :--- | :---: | :--- |
| `BANK_SWITCH_TIMEOUT` | Upstream bank router or switch latency during authorization | `error_source = 'bank'`, timeout keywords in description | High | Generate alternate Razorpay Payment Link; prompt alternate payment method |
| `GATEWAY_TECHNICAL_FAILURE` | Gateway server error or acquiring network degradation | `error_source = 'gateway'`, server error codes | High | Direct payment link bypassing degraded acquiring hop |
| `AUTHENTICATION_FAILURE` | OTP timeout, 3DS challenge drop, or authentication decline | `error_step = 'payment_authentication'`, OTP/3DS errors | Medium | Payment link with localized vernacular assistance |
| `INSUFFICIENT_FUNDS` | Issuer declined transaction due to insufficient balance | `error_code = 'INSUFFICIENT_FUNDS'`, balance decline | Low–Medium | Delayed retry window or alternate payment method link |
| `PAYMENT_METHOD_EXPIRED` | Saved card token expired or invalid instrument | Expiry error codes, token failure | High | Payment link requesting updated payment instrument |
| `LIMIT_EXCEEDED` | Daily or per-transaction card/account limit breached | Card limit error codes from issuer | Medium | Payment link or split payment suggestion |
| `MANDATE_FAILURE` | Recurring auto-debit mandate registration or execution failed | Recurring token failure, mandate decline | Medium | Mandate update link or ad-hoc invoice payment link |
| `SUBSCRIPTION_FAILURE` | Scheduled subscription renewal charge declined | Subscription lifecycle event with debit failure | High | Scheduled billing retry window or self-serve renewal link |
| `B2B_RECEIVABLE_DELAY` | Corporate invoice unpaid beyond agreed payment terms | `daysOverdue > 0`, Net-30/60 term expiration | High | Structured commercial invoice reminder or direct corporate payment link |
| `CHECKOUT_ABANDONMENT` | Buyer dropped off during checkout funnel | Checkout session abandonment telemetry | High | Personalized cart recovery link with preserved cart items |
| `PAYMENT_DEGRADATION` | Generalized checkout drop without specific bank codes | Standard degradation events at checkout | Medium | Fallback payment link |
| `UNKNOWN_FAILURE` | Insufficient or uninformative provider telemetry | Generic string (`"Payment failed"`, no error codes) | Conservative Abstention | Route to human review; cap confidence at $\le 0.35$; abstain from automated execution |

---

## Recovery Strategies

Revflow maintains an authoritative catalog of recovery strategies, explicitly distinguished by **Execution Mode**:

| Strategy ID | Strategy Name | Execution Mode | Provider | Description & Safeguards |
| :--- | :--- | :---: | :---: | :--- |
| `CREATE_PAYMENT_LINK` | Razorpay Payment Link | `LIVE_PROVIDER` | Razorpay API | **Live external financial action.** Generates an idempotent Razorpay Payment Link in Test Mode. Requires policy `ALLOW` and valid AI diagnosis. |
| `SCHEDULE_RETRY_WINDOW` | Smart Retry Window | `SIMULATED` | Internal | Calculates optimal billing retry timing aligned with merchant subscription policies without customer disruption. |
| `CHECKOUT_RECOVERY` | Cart Drop-off Recovery | `SIMULATED` | Internal | Generates preserved checkout session parameters and expiration nudges. |
| `CUSTOMER_OUTREACH` | Customer Outreach | `SIMULATED` | Internal / Comm | Formats contextual recovery notifications across verified channels with frequency caps. |
| `INVOICE_REMINDER` | B2B Invoice Reminder | `SIMULATED` | Internal | Issues corporate accounts receivable reminders referencing agreed commercial terms. |
| `DISPATCH_VERNACULAR_ASSIST` | Vernacular Messaging | `SIMULATED` | Internal | Generates localized Hindi/Hinglish copy to reduce customer authentication hesitation. |
| `RECORD_PROMISE_TO_PAY` | Promise-to-Pay Tracker | `SIMULATED` | Internal | Logs customer payment commitments and pauses active recovery attempts until target date. |
| `REQUEST_MANUAL_REVIEW` | Human Escalation | `CONTROL` | Control Plane | Routes ambiguous, high-value, or low-confidence cases to human operators. Approval cannot override `BLOCK`. |
| `NO_ACTION` | Explicit Abstention | `CONTROL` | Control Plane | Explicitly halts recovery when customer friction or intervention cost exceeds potential recovery value. |

### The Razorpay Payment Link Recovery Lifecycle
Revflow enforces an absolute accounting boundary between link creation and financial recovery:

1. **Link Creation**: Revflow calls `POST /v1/payment_links` on Razorpay Test Mode with a bounded amount and deterministic reference ID.
2. **Action Executed**: The link is stored in `recovery_actions` with status `EXECUTED`. **Revenue recovered remains ₹0.**
3. **Customer Settlement**: The buyer opens the link and completes payment in the Razorpay checkout.
4. **Provider Confirmation**: Razorpay dispatches an HMAC-signed `payment_link.paid` webhook to Revflow.
5. **Ledger Reconciliation**: Revflow validates the signature, correlates the payment link ID, verifies the exact paise amount, and marks the case `RESOLVED`. **Only now is revenue marked as recovered.**

---

## Razorpay Integration

Revflow integrates directly with Razorpay's API in **Test Mode** (`rzp_test_`):

- **Payment Link Creation**: Calls `POST /v1/payment_links` using HTTP Basic Authentication (`RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET`).
- **Webhook Ingestion**: Express receives raw payloads at `POST /api/webhooks/razorpay` via `express.raw({ type: 'application/json' })`.
- **Cryptographic Signature Verification**: Validates the `X-Razorpay-Signature` header against the raw request body using HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET`:
  $$\text{Expected Signature} = \text{HMAC-SHA256}(\text{rawBody}, \text{secret})$$
- **Supported Webhook Events**:
  - `payment_link.paid`: Triggers full recovery reconciliation for Payment Link workflows.
  - `payment.captured`: Reconciles direct captured payments.
  - `payment.failed`: Ingests payment failure telemetry to create or update recovery cases.
- **Idempotency & Collision Prevention**: Every link uses a deterministic reference ID:
  ```text
  Format: rc_<caseId>_<paymentToken>_v<attempt>
  Example: rc_4_pay_test_whatsapp_preflight_01_v1 (Max 40 chars)
  ```
  Database constraints enforce that only one active payment link can exist per case at any time (`recovery_actions_case_active_plink_idx`).
- **Strict Test Mode Guard**: Policy Rule 3 asserts that credentials begin with `rzp_test_`. Production live-money keys are blocked to guarantee non-monetary execution.

---

## System Architecture

```mermaid
graph TB
    subgraph "External Providers"
        RZP[Razorpay Test Mode API]
        WH[Razorpay Webhooks]
        AI[AI Provider / Gemini / OpenAI]
    end

    subgraph "Revflow Backend (Node.js / Express)"
        ING[Event Ingestion & Normalizer]
        REPO[(PostgreSQL / InMemory)]
        TAX[Three-Layer Failure Intelligence]
        DIAG[AI Diagnosis Service]
        STRAT[Strategy Registry & ERV Scorer]
        POL[12 Deterministic Policy Rules]
        STOP[Stopping Engine]
        EXEC[Payment Link Executor]
        RECON[Reconciliation Service]
        WRK[Autonomous Recovery Worker]
    end

    subgraph "Revflow Frontend (React 19 / Vite)"
        DASH[Operations Command Center]
        QUEUE[Recovery Queue]
        DETAIL[Case Detail 6-Stage Pipeline]
        INTEL[Failure Intelligence Centerpiece]
        AUDIT[Audit Trail & Governance View]
    end

    WH -->|HMAC-SHA256 Signed POST| ING
    ING --> REPO
    REPO --> WRK
    WRK --> TAX
    TAX --> DIAG
    DIAG <-->|Structured JSON| AI
    DIAG --> STRAT
    STRAT --> POL
    POL --> STOP
    STOP -->|ALLOW| EXEC
    EXEC -->|POST /v1/payment_links| RZP
    WH -->|payment_link.paid| RECON
    RECON --> REPO
    REPO <--> DASH & QUEUE & DETAIL & INTEL & AUDIT
```

---

## Data / Case Model

The core recovery entity is the **Recovery Case**, representing a unique payment failure lifecycle:

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `BIGSERIAL` | Unique internal database identifier |
| `payment_id` | `TEXT UNIQUE` | Authoritative provider payment identifier (e.g., `pay_TXH3filWdhVk3j`) |
| `order_id` | `TEXT` | Associated merchant order reference |
| `amount` | `BIGINT` | Transaction value in integer paise (e.g., `50000` = ₹500.00) |
| `currency` | `CHAR(3)` | ISO currency code (strictly `INR`) |
| `customer_reference` | `TEXT` | Customer contact identifier or phone number |
| `risk_status` | `TEXT` | Core state: `OPEN`, `RECOVERABLE`, `RESOLVED`, `SUPPRESSED` |
| `risk_reason` | `TEXT` | Human-readable explanation of current risk posture |
| `risk_level` | `TEXT` | Exposure classification: `LOW`, `MEDIUM`, `HIGH` |
| `action_status` | `TEXT` | Execution state: `NOT_STARTED`, `PENDING`, `EXECUTING`, `ACTION_EXECUTED`, `RECOVERED`, `FAILED` |
| `outcome` | `TEXT` | Settlement state: `null`, `PAID`, `REFUNDED`, `RESOLVED` |
| `recovered_amount` | `BIGINT` | Authoritative recovered revenue in integer paise (starts at `0`) |
| `autonomy_status` | `TEXT` | Worker state: `INACTIVE`, `QUEUED`, `CLAIMED`, `COMPLETED`, `REVIEW_REQUIRED`, `BLOCKED`, `RETRY_SCHEDULED`, `FAILED` |
| `escalation_status` | `TEXT` | Human review state: `NONE`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED` |
| `is_demo` | `BOOLEAN` | Partition flag isolating demo recovery cases from production |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | Immutable audit timestamps |

### Related Entities
- `revenue_events`: Ingested payment failure and lifecycle telemetry payloads.
- `provider_webhook_events`: Raw webhook event store with signature verification status.
- `ai_diagnoses`: AI-generated root cause, confidence score, evidence citations, and candidate actions.
- `recovery_actions`: Executed interventions, idempotency keys, policy decisions, and provider action IDs.
- `recovery_outcomes`: Authoritative provider payment settlements and four-point reconciliation results.
- `audit_events`: Append-only audit trail capturing every state change across 28 typed events.

---

## Safety, Governance & Financial Invariants

### The 12 Deterministic Policy Rules
Every intervention must pass through Revflow's deterministic policy engine (`BLOCK ≻ REVIEW ≻ ALLOW`):

| # | Rule Name | Guardrail Logic | Violation Action |
| :-: | :--- | :--- | :-: |
| **1** | `context_integrity` | Rejects execution if `paymentId`, `amount`, or `currency` is missing or malformed. | `BLOCK` |
| **2** | `amount_integrity` | Verifies amount $> 0$ and valid integer paise. AI cannot specify or alter amounts. | `BLOCK` |
| **3** | `currency_integrity` | Asserts currency equals `INR`. Mismatched currencies are rejected. | `BLOCK` |
| **4** | `test_mode_verification` | Asserts provider credentials match `rzp_test_`. Production keys are strictly rejected. | `BLOCK` |
| **5** | `terminal_payment` | Blocks execution if original payment was already captured, settled, or refunded. | `BLOCK` |
| **6** | `case_status` | Halts execution if the case is already `RESOLVED` or `SUPPRESSED`. | `BLOCK` |
| **7** | `resolved_outcome_check` | Asserts no prior recovery outcome has already credited this transaction. | `BLOCK` |
| **8** | `action_allowlist` | Ensures only explicitly registered, authorized strategies can execute. | `BLOCK` |
| **9** | `confidence_threshold` | Demands human oversight if AI diagnostic confidence is below 0.65. | `REVIEW` |
| **10** | `max_attempts` | Caps automated recovery at 2 attempts per case to prevent customer friction. | `REVIEW` |
| **11** | `duplicate_action` | Blocks execution if an active payment link already exists for this case. | `BLOCK` |
| **12** | `high_value_escalation` | Transactions exceeding ₹25,000 require explicit human operator approval. | `REVIEW` |
| — | `cooldown_period` | Enforces a mandatory 30-minute quiet period between automated recovery actions. | `REVIEW` |

### Explicit Stopping Engine (`stoppingEngine.js`)
The stopping engine evaluates four terminal dispositions:
- **`HARD_STOP`**: Halts all processing (`PAYMENT_ALREADY_SETTLED`, `INVOICE_ALREADY_PAID`, `SUBSCRIPTION_CANCELLED`, `MAX_ATTEMPTS_EXCEEDED`).
- **`WAIT`**: Suspends action pending temporal windows (`COOLDOWN_ACTIVE` 30m window, `B2B_TERMS_NOT_REACHED`).
- **`ESCALATE`**: Demands human sign-off (`HIGH_VALUE_EXPOSURE`, `COLLECTION_WINDOW_EXPIRED`).
- **`CONTINUE`**: Safe to proceed with policy evaluation.

### Human Escalation Invariant
Cases flagged for `REVIEW` enter `PENDING_APPROVAL`. Operators can approve or reject via the UI or API.
**Core Governance Invariant**: Human approval can resolve a `REVIEW`, but **can NEVER override a `BLOCK`**.

---

## Frontend / Product Walkthrough

Revflow provides an operator-grade financial operations dashboard built in React 19:

### 1. Operations Command Center (Overview)
- **KPI Command Strip**: Real-time revenue metrics:
  - **Revenue at Risk**: Active unrecovered exposure (e.g., ₹500 in Case #4).
  - **Recovered Revenue**: Authoritative ledger-verified settlements (e.g., ₹1,750 across Cases #1–#3).
  - **Active Pipeline**: Count of open recovery interventions.
  - **Recovery Rate**: Percentage of exposed revenue successfully recovered.
- **Recovery Outcomes & Settlement Verification Card**: Summary of verified settlements, recovery conversion, and provider execution duration.
- **Portfolio Decision Funnel**: Step-by-step verification funnel showing 0 policy violations across ingested failures, diagnoses, evaluations, executions, and reconciliations.
- **Failure Category Distribution**: Portfolio breakdown showing canonical failure categories and conservative abstention guarantees.
- **Active Recovery Spotlight**: Deep dive into active cases awaiting customer settlement (Case #4).

### 2. Recovery Queue (`/queue`)
- Filterable list of all cases with real-time status badges (`RECOVERABLE`, `RESOLVED`, `SUPPRESSED`).
- Risk level indicators, failure reason summaries, monetary amounts, and quick navigation into case details.

### 3. Failure Intelligence (`/intelligence`)
- Visual exploration of the Three-Layer Failure Architecture.
- Shows how raw provider telemetry maps into canonical taxonomy families with grounded citations and transparent unknowns.

### 4. Recovery Case Detail (`/case_detail`)
The centerpiece operator workspace presenting the **6-Stage Continuous Operational Pipeline**:
- **Stage 01 — Provider Telemetry**: Authoritative raw facts from the payment gateway.
- **Stage 02 — Failure Intelligence**: Canonical family classification, AI diagnosis, grounded evidence basis, and explicit unknowns.
- **Stage 03 — Recovery Strategy**: Candidate strategy ranking table with Expected Recovery Value (ERV) scores.
- **Stage 04 — Policy Governance**: Detailed 12-rule policy evaluation breakdown with stopping criteria disposition.
- **Stage 05 — Execution & Reconciliation**: Action dispatch controls, active Razorpay Payment Link display, and four-point reconciliation results.
- **Stage 06 — Verified Audit Trail**: Complete append-only timeline of every event, diagnosis, policy check, and settlement.

### 5. Multi-Playbook Engine (`/playbooks`)
- Configuration and telemetry across the 4 supported revenue domains: Payment Degradation, Checkout Drop-Off, Subscription Recovery, and B2B Receivables.

### 6. Governance & Audit Trail (`/audit`)
- Immutable log of all system transitions, policy decisions, and operator approval actions.

### 7. Recovery Lab (`/lab`)
- Interactive simulation playground to test failure scenarios against the AI diagnosis and policy engine without triggering external side-effects.

---

## Demo Flow (5-Minute Walkthrough)

To experience the complete end-to-end recovery loop on the live deployment:

1. **Start at Overview**: Navigate to [https://revflow.onrender.com](https://revflow.onrender.com). View the **Operations Command Center**. Note that **₹1,750** is verified recovered, **₹500** is active at risk, and the **Portfolio Decision Funnel** shows 0 policy violations.
2. **Review Resolved Cases in Queue**: Click **View Recovery Queue**. Observe Cases #1, #2, and #3 marked `RESOLVED` with verified Razorpay settlements.
3. **Inspect a Resolved Case**: Click **Case #1** or **Case #3**. Walk through the 6-stage pipeline to see how raw provider telemetry was ingested, diagnosed with conservative confidence, policy-approved, executed as a Razorpay link, and verified via an HMAC-signed webhook.
4. **Open Active Case #4**: Return to the queue and select **Case #4** (`pay_test_whatsapp_preflight_01`, ₹500 at risk).
5. **Inspect Provider Telemetry**: View Stage 01. Note the authoritative failure reason: `Non-terminal payment failure: Bank switch timeout`.
6. **Inspect AI Diagnosis & Grounding**: View Stage 02. Observe classification under `BANK_SWITCH_TIMEOUT`, grounded in verified provider facts with explicit unknowns.
7. **Inspect Policy Governance**: View Stage 04. Confirm all 12 policy rules passed (`ALLOW`) with zero violations.
8. **View Active Razorpay Payment Link**: View Stage 05. Locate the active Test Mode Payment Link (`https://rzp.io/rzp/7xifK9c`).
9. **Complete Test Mode Payment**: Open the payment link in a new tab. In Razorpay's Test Mode checkout, select **Netbanking** (e.g., Bank of Baroda), click **Pay Now**, and on the Razorpay mock bank screen, click **Success**.
10. **Reconciliation & Ledger Credit**: Return to Revflow. The signed `payment_link.paid` webhook arrives at Revflow's webhook receiver. Four-point reconciliation validates the signature, amount, currency, and reference ID. Case #4 transitions to `RESOLVED`, and total recovered revenue updates to **₹2,250** with **100% recovery rate**.

---

## API Documentation

All endpoints return JSON and use standard HTTP response codes:

### System & Health
| Method | Path | Description | Authentication |
| :--- | :--- | :--- | :---: |
| `GET` | `/api/health` | Service health and operational status | None |

### Recovery Cases
| Method | Path | Description | Key Parameters |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/cases` | List recovery cases | Query: `limit`, `offset`, `status`, `demo` |
| `GET` | `/api/cases/:id` | Get full case detail (events, actions, outcomes, audit) | Path: `id` |
| `GET` | `/api/cases/metrics` | Retrieve aggregated portfolio recovery metrics | Query: `demo=true` |
| `GET` | `/api/cases/escalations` | List cases pending human operator review | None |

### Case Interventions & Governance
| Method | Path | Description | Key Parameters |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/cases/:id/diagnosis` | Generate AI failure diagnosis for case | Path: `id` |
| `GET` | `/api/cases/:id/diagnosis` | Retrieve persisted AI diagnosis | Path: `id` |
| `POST` | `/api/cases/:id/policy` | Evaluate 12 policy rules against proposed action | Body: `{ candidateAction }` |
| `POST` | `/api/cases/:id/recovery-actions` | Execute approved recovery action (e.g. Razorpay Link) | Body: `{ actionType, overrideReason }` |
| `GET` | `/api/cases/:id/recovery-actions` | List historical recovery actions for case | Path: `id` |
| `GET` | `/api/cases/:id/recovery-outcome` | Retrieve verified settlement outcome | Path: `id` |
| `POST` | `/api/cases/:id/escalations/approve` | Human operator approves case under review | Body: `{ approvedBy, notes }` |
| `POST` | `/api/cases/:id/escalations/reject` | Human operator rejects case recovery | Body: `{ rejectedBy, notes }` |

### Webhooks & Telemetry
| Method | Path | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/events` | Ingest raw revenue or payment failure event | Body: `{ eventType, paymentId, amount, ... }` |
| `POST` | `/api/webhooks/razorpay` | Ingest Razorpay provider webhook | Header: `X-Razorpay-Signature`, Raw JSON |
| `POST` | `/api/webhooks/whatsapp` | Ingest inbound Twilio WhatsApp webhook | Form URL-encoded Twilio payload |

### Analytics & Lab
| Method | Path | Description | Key Parameters |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/recovery/analytics` | Portfolio-wide recovery analytics | None |
| `GET` | `/api/recovery/analytics/strategies` | Strategy effectiveness and ERV metrics | None |
| `GET` | `/api/recovery/analytics/failures` | Taxonomy failure distribution metrics | None |
| `GET` | `/api/recovery/adaptive-model` | Adaptive learning model inspection | None |
| `POST` | `/api/recovery/lab/run-scenario` | Execute simulated recovery scenario | Body: `{ scenarioId }` |
| `POST` | `/api/batch/evaluate` | Batch evaluate recovery cases | Body: `{ cases: [...] }` |

---

## Database

Revflow uses **PostgreSQL (v15+)** with strict constraints, indexes, and an automatic fallback to an in-memory repository for lightweight local testing:

```text
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│     revenue_events     │       │     recovery_cases     │       │      ai_diagnoses      │
├────────────────────────┤       ├────────────────────────┤       ├────────────────────────┤
│ id BIGSERIAL PK        │       │ id BIGSERIAL PK        │◄──┐   │ id BIGSERIAL PK        │
│ event_id TEXT UNIQUE   │       │ payment_id TEXT UNIQUE │   │   │ recovery_case_id FK    │
│ payment_id TEXT        │       │ amount BIGINT          │   │   │ confidence NUMERIC     │
│ raw_payload JSONB      │       │ risk_status TEXT       │   │   │ evidence JSONB         │
└────────────────────────┘       │ recovered_amount BIGINT│   │   │ proposed_action TEXT   │
                                 └───────────┬────────────┘   │   └────────────────────────┘
                                             │ 1              │
                                             │                │
                        ┌────────────────────┼────────────────┼────────────────────┐
                        │ N                  │ N              │ N                  │ N
                        ▼                    ▼                │                    ▼
             ┌─────────────────────┐┌─────────────────────┐   │         ┌─────────────────────┐
             │  recovery_actions   ││  recovery_outcomes  │   │         │    audit_events     │
             ├─────────────────────┤├─────────────────────┤   │         ├─────────────────────┤
             │ id BIGSERIAL PK     ││ id BIGSERIAL PK     │   │         │ id BIGSERIAL PK     │
             │ recovery_case_id FK ││ recovery_case_id FK │   │         │ recovery_case_id FK │
             │ action_type TEXT    ││ recovery_action_id  ├───┘         │ event_type TEXT     │
             │ provider_action_id  ││ provider_payment_id │             │ metadata JSONB      │
             │ status TEXT         ││ verified BOOLEAN    │             │ created_at TIMESTAMPTZ
             └─────────────────────┘└─────────────────────┘             └─────────────────────┘
```

### Migration Execution
Database schema migrations are idempotent and executed via:
```bash
pnpm db:migrate
```

---

## Environment Variables

All configuration is parsed and validated at boot using Zod (`backend/src/config/env.js`).

### Application & Server
| Variable | Description | Default | Required in Prod |
| :--- | :--- | :--- | :---: |
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | Yes |
| `PORT` | HTTP server listening port | `3001` | No |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` | Yes |
| `FRONTEND_ORIGIN` | Allowed CORS origin | `undefined` | No |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` | No |

### Razorpay Integration (Test Mode)
| Variable | Description | Example / Placeholder | Required in Prod |
| :--- | :--- | :--- | :---: |
| `RAZORPAY_KEY_ID` | Razorpay Key ID (must begin with `rzp_test_`) | `rzp_test_your_key_id` | Yes |
| `RAZORPAY_KEY_SECRET` | Razorpay Key Secret | `your_razorpay_secret` | Yes |
| `RAZORPAY_WEBHOOK_SECRET` | Secret for HMAC-SHA256 signature verification | `your_webhook_secret` | Yes |
| `RAZORPAY_MAX_AUTOMATED_ATTEMPTS` | Maximum automated link creation attempts | `2` | No |
| `RAZORPAY_HIGH_VALUE_THRESHOLD_PAISE` | Threshold in paise triggering review | `2500000` (₹25,000) | No |
| `RAZORPAY_ACTION_COOLDOWN_MINUTES` | Mandatory quiet period between actions | `30` | No |

### AI Provider
| Variable | Description | Example / Placeholder | Required in Prod |
| :--- | :--- | :--- | :---: |
| `AI_PROVIDER` | AI adapter (`openai-compatible`, `gemini`) | `gemini` | No |
| `AI_API_KEY` | Upstream AI API Key | `your_ai_api_key` | Yes |
| `AI_MODEL` | Target language model | `gemini-2.5-flash` | No |
| `AI_BASE_URL` | Upstream AI endpoint | `https://api.openai.com/v1` | No |
| `AI_CONFIDENCE_THRESHOLD` | Minimum confidence for automatic execution | `0.65` | No |

### Autonomous Recovery Worker
| Variable | Description | Default | Required in Prod |
| :--- | :--- | :--- | :---: |
| `AUTONOMOUS_RECOVERY_ENABLED` | Enable background autonomy worker | `false` | No |
| `AUTONOMY_WORKER_POLL_INTERVAL_MS` | Queue poll frequency in milliseconds | `5000` | No |
| `AUTONOMY_WORKER_LEASE_SECONDS` | Distributed lock lease duration | `60` | No |
| `AUTONOMY_WORKER_MAX_RETRIES` | Max attempts before marking failed | `3` | No |
| `AUTONOMY_WORKER_BASE_BACKOFF_SECONDS` | Exponential retry backoff base | `30` | No |

---

## Local Development

### Prerequisites
- **Node.js**: `v20.0.0` or higher
- **Package Manager**: `pnpm` (`npm install -g pnpm`)
- **PostgreSQL**: `v15.0+` (optional; memory repository runs if `DATABASE_URL` is omitted)

### 1. Clone & Install
```bash
git clone https://github.com/gititayush/recover-ai.git
cd recover-ai
pnpm install
pnpm --dir frontend install
```

### 2. Configure Environment
Create a `.env` file in the project root:
```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/recoverai
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
AI_PROVIDER=gemini
AI_MODEL=gemini-2.5-flash
AI_API_KEY=your_api_key
```

### 3. Apply Migrations & Start Development Servers
```bash
# Run database migrations
pnpm db:migrate

# Start Backend API (runs on port 3001)
pnpm start

# In a second terminal, start React Dashboard (runs on port 5173)
pnpm frontend
```

### 4. Build for Production
```bash
pnpm --dir frontend build
```

---

## Testing

Revflow is backed by an extensive, high-assurance test suite covering unit logic, integration flows, policy safety, and adversarial invariants.

Run the test suite:
```bash
pnpm test
```

### Verified Test Results
```text
 Test Files  28 passed (28)
      Tests  566 passed (566)
   Duration  10.53s
```

All **28 test suites** pass with 0 failures:
1. `adaptiveLearning.test.js`: Validates adaptive strategy scoring and Bayesian feedback loops.
2. `adversarialFinancialSafety.test.js`: 81 adversarial tests verifying financial boundary conditions.
3. `autonomousWhatsAppBridge.test.js`: Integration tests for autonomous communication dispatch.
4. `autonomyWorker.test.js`: Atomic lease locking, concurrency safety, and queue worker logic.
5. `b2bReceivables.test.js`: Corporate invoice payment terms and overdue workflows.
6. `batchRecovery.test.js`: High-throughput batch case evaluation and provenance isolation.
7. `checkoutDropOff.test.js`: Cart abandonment and funnel drop-off recovery.
8. `communicationFrontendContract.test.js`: API contract validation for communication components.
9. `demoPartitioning.test.js`: Strict isolation between demo and production cases.
10. `demoPortfolio.test.js`: End-to-end 8-case demo portfolio verification.
11. `diagnosis.test.js`: AI diagnosis generation, Zod schema validation, and fallback handling.
12. `events.test.js`: Ingestion, normalization, and deduplication of revenue events.
13. `failureIntelligence.test.js`: Three-Layer Failure Architecture and grounding proof guarantees.
14. `humanEscalation.test.js`: Review-required gates, approval lifecycle, and block invariants.
15. `multilingualCommunication.test.js`: English, Hindi, and Hinglish copy generation.
16. `outcomeAnalytics.test.js`: Portfolio analytics, recovery velocity, and breakdown metrics.
17. `outcomeReconciliation.test.js`: Multi-key reconciliation and zero double-counting proof.
18. `playbookEngine.test.js`: Multi-playbook lifecycle and domain action validation.
19. `playbooksAndEvaluation.test.js`: Playbook candidate action scoring integration.
20. `policyAndExecution.test.js`: The 12 deterministic policy rules and bounded execution.
21. `postgresSchemaCompatibility.test.js`: PostgreSQL enum constraints and migration idempotency.
22. `razorpayWebhook.test.js`: HMAC-SHA256 signature verification and webhook routing.
23. `recoveryLab.test.js`: Interactive scenario simulation execution.
24. `smartRetryLifecycle.test.js`: Temporal retry scheduling and quiet period adherence.
25. `stoppingEngine.test.js`: Stopping criteria: `HARD_STOP`, `WAIT`, `ESCALATE`, `CONTINUE`.
26. `strategyRegistryAndScoring.test.js`: Strategy catalog definitions and ERV scoring formulas.
27. `subscriptionRecovery.test.js`: Involuntary subscription churn and mandate recovery.
28. `whatsappProvider.test.js`: Twilio WhatsApp provider sandbox boundaries and error containment.

---

## Deployment

Revflow is deployed to **Render** as a unified production web service:

- **Live URL**: [https://revflow.onrender.com](https://revflow.onrender.com)
- **Architecture**: Single unified web service where Node/Express serves both the `/api/*` REST routes and the compiled static React SPA assets from `frontend/dist`.
- **Database**: Managed PostgreSQL on Render.
- **Build Command**: `pnpm install && pnpm --dir frontend install && pnpm --dir frontend build`
- **Start Command**: `pnpm start`
- **Webhook Endpoint**: `https://revflow.onrender.com/api/webhooks/razorpay`

---

## Observability & Auditability

Revflow provides complete operational transparency for financial auditing:
- **Append-Only Event Ledger**: Every inbound event, diagnosis, policy check, action dispatch, and reconciliation outcome is immutably logged to `audit_events`.
- **Provider Action Tracing**: Every generated payment link records its external `provider_action_id` (e.g. `plink_TXh7mOMAv1ZqPB`), request payload, response status, and creation timestamp.
- **State Transition Proof**: Case updates record exact lease tokens (`autonomy_lease_token`), worker process IDs (`locked_by`), retry counts, and timestamped error reasons.
- **Cryptographic Webhook Log**: Raw webhook payloads and HMAC signature verification verdicts are preserved in `provider_webhook_events`.

---

## Design Principles

1. **Evidence-Grounded AI**: The model may only cite verified provider facts. When evidence is generic, the system conservatively abstains rather than inventing a failure cause.
2. **Deterministic Financial Governance**: Software rules—not language models—own financial logic, payment amounts, and execution permissions.
3. **Bounded Financial Actions**: Autonomous execution is strictly confined to generating pre-bounded, non-destructive payment links.
4. **Idempotent Execution**: Actions and reference IDs are cryptographically derived to prevent duplicate payment links or double charging.
5. **Reconciliation Before Recognition**: Generating a link or sending a notification never credits revenue. Revenue is recognized only when signed provider webhooks confirm settlement.
6. **Separation of Reasoning from Execution**: AI proposes, policy decides, executor acts, provider verifies, and Revflow reconciles.

---

## Limitations

- **Razorpay Test Mode Sandbox**: The current deployment operates in Razorpay Test Mode (`rzp_test_`). Transactions are non-monetary test simulations.
- **AI Provider Rate Limits**: During peak upstream demand, cloud AI providers may return HTTP 429 or 503 errors. Revflow safely fails closed to human review rather than executing without diagnostic validation.
- **External Webhook Delivery**: Reconciliation depends on Razorpay webhook delivery. Network partitions or delayed webhook retries will defer recovery recognition until receipt.
- **Twilio Sandbox Messaging Constraints**: Outbound WhatsApp custom body messaging requires pre-approved Twilio Content Templates (`ContentSid`), which restricts unapproved custom copy in trial sandboxes.
- **Conservative Abstention**: Generic errors (`"Payment failed"`) intentionally yield low confidence ($\le 0.35$), preventing automated recovery when provider telemetry is absent.

---

## Security

- **Zero Exposure of Secrets**: Provider keys and database credentials exist exclusively in environment variables and are excluded from git.
- **HMAC-SHA256 Webhook Verification**: Inbound Razorpay webhooks are cryptographically authenticated against raw request bodies before processing.
- **Integer Arithmetic**: All monetary calculations use integer paise to eliminate floating-point precision vulnerabilities.
- **Strict Zod Input Validation**: Every API payload and AI response is validated against strict runtime schemas.
- **SQL Injection Prevention**: All database queries utilize parameterized values through the `pg` driver.

---

## Project Status

Revflow is a **completed, demo-ready implementation** built for the **Razorpay Buildathon 2026** (Track 03: AI Revenue Recovery):
- ✅ End-to-end recovery pipeline operational and deployed on Render.
- ✅ Live Razorpay Test Mode Payment Link generation, webhook capture, and ledger reconciliation verified.
- ✅ 12-rule deterministic policy engine and stopping criteria active.
- ✅ 566 of 566 automated tests passing across 28 test suites.
- ✅ Multi-playbook support spanning payments, drop-offs, subscriptions, and B2B receivables.
