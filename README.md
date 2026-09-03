# Revflow — Autonomous AI Revenue-Recovery Control Plane

> **Revflow transforms payment failures from passive error logs into an autonomous, bounded recovery control plane: detecting revenue leaks, extracting provider facts, diagnosing failure root causes, evaluating candidate strategies, enforcing deterministic financial policy, executing bounded interventions, verifying provider outcomes, and reconciling ledgers without double-counting.**

[![Razorpay Buildathon 2026](https://img.shields.io/badge/Razorpay_Buildathon-Track_03:_AI_Revenue_Recovery-blue.svg)](https://razorpay.com)
[![Tests](https://img.shields.io/badge/Tests-498%2F498%20Passing-brightgreen.svg)]()
[![Suites](https://img.shields.io/badge/Suites-23%20Passing-brightgreen.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15+-blue.svg)](https://postgresql.org)
[![Razorpay](https://img.shields.io/badge/Razorpay-Test%20Mode-0C2340.svg)](https://razorpay.com)
[![Current Status](https://img.shields.io/badge/Status-Milestone%208%20Verified-success.svg)]()

🌐 **Live Demonstration Deployment**: [https://revflow.onrender.com](https://revflow.onrender.com)
📦 **Repository**: [https://github.com/gititayush/recover-ai](https://github.com/gititayush/recover-ai)
📖 **Technical Architecture Guide**: [docs/architecture.md](docs/architecture.md)

---

## 1. Core Product Narrative

When a payment fails at checkout, during recurring subscription renewal, or against a commercial B2B invoice, traditional payment infrastructure simply logs an error code and drops the customer. Merchants suffer silent, compounding revenue leakage:
- **Transient Gateway & Switch Drops**: Peak-hour bank router timeouts abandon high-intent buyers who would pay immediately via a direct fallback link.
- **Checkout Friction & Drop-Off**: Customers hesitate during 3DS/OTP friction without contextual assistance.
- **Involuntary Subscription Churn**: Recurring card mandates fail due to temporary account limits or issuer maintenance windows.
- **Aged B2B Receivables**: Invoices drift past terms because accounts receivable teams lack automated, term-aware recovery workflows.

Revflow is **not** an AI chatbot, **not** a simple payment link generator, and **not** a passive analytics dashboard.

Revflow is an **autonomous revenue-recovery control plane** operating under an uncompromising engineering principle:

```text
┌─────────────┐     ┌────────────────┐     ┌───────────────┐     ┌───────────────────┐     ┌────────────────────┐     ┌────────────────┐
│ AI Proposes │ ──> │ Policy Decides │ ──> │ Executor Acts │ ──> │ Provider Verifies │ ──> │ Revflow Reconciles │ ──> │ Revflow Learns │
└─────────────┘     └────────────────┘     └───────────────┘     └───────────────────┘     └────────────────────┘     └────────────────┘
  (Advisory           (Authoritative         (Bounded Link or      (External Signed          (Verifies Exact           (Portfolio
   Inference)          Guardrails)            Simulated Action)     Provider Webhook)         Amount & Ledger)          Analytics)
```

### The Autonomous Recovery Pipeline

```text
Razorpay Event
      │
      ▼
Revenue-Risk Detection (Multi-playbook event matching & state determination)
      │
      ▼
Recovery Case Creation (Unique case lifecycle & append-only audit trail)
      │
      ▼
Failure Intelligence (3-Layer evidence extraction & canonical failure classification)
      │
      ▼
AI Advisory Diagnosis (Contextual synthesis, root-cause explanation & unknown discovery)
      │
      ▼
Candidate Recovery Strategies (Scored by deterministic Expected Recovery Value)
      │
      ▼
Deterministic Policy Gate (12 invariant financial rules + stopping engine: BLOCK ≻ REVIEW ≻ ALLOW)
      │
      ▼
Bounded Execution (LIVE_PROVIDER Razorpay Payment Link or SIMULATED domain intervention)
      │
      ▼
Provider Verification (External webhook HMAC-SHA256 signature verification)
      │
      ▼
Ledger Reconciliation (Identity, amount, currency, and action correlation verification)
      │
      ▼
Outcome Learning & Analytics (Provenance-isolated portfolio velocity & failure mode telemetry)
```

> [!IMPORTANT]
> **The Golden Rule of Revenue Accounting: Action Execution $\neq$ Recovered Revenue**
> Generating a recovery link or dispatching an alert records operational intent; it does **not** count as recovered revenue.
>
> Revenue is credited to the merchant ledger **only** after the complete verification loop closes:
> **Customer pays $\rightarrow$ Provider-signed Razorpay webhook $\rightarrow$ HMAC-SHA256 signature verification $\rightarrow$ Multi-key reconciliation (provider ID, exact paise, currency, action reference) $\rightarrow$ Case marked RESOLVED.**

---

## 2. Current Verified Production State

The production deployment at [https://revflow.onrender.com](https://revflow.onrender.com) is continuously verified against live PostgreSQL persistence and Razorpay Test Mode webhooks:

*Note: These values reflect the current verified demonstration state on Render (commit `5020348`), not hard-coded constants.*

```json
{
  "revenue_at_risk": 50000,
  "revenue_recovered": 175000,
  "recovery_rate": 0.7778,
  "total_cases": 4,
  "open_cases": 1,
  "resolved_cases": 3,
  "executed_actions": 4,
  "confirmed_recoveries": 3,
  "pending_recoveries": 1,
  "blocked_cases": 0,
  "review_required_cases": 0
}
```

### Authoritative Case Ledger

| Case | Database ID | Authoritative Payment ID | Amount | Provider Telemetry | Current State | Outcome | Verified Recovered |
| :---: | :---: | :--- | :---: | :--- | :---: | :---: | :---: |
| **Case #1** | `1` | `pay_TXH3filWdhVk3j` | ₹500 | `Payment failed` (Generic) | `RESOLVED` | ✅ Paid (`plink_TWqGhXHacJQ8O3`) | **₹500.00** |
| **Case #2** | `2` | `pay_TXHXFLRWrIcSRC` | ₹500 | `Payment failed` (Generic) | `RESOLVED` | ✅ Paid (`plink_new_case_2_live`) | **₹500.00** |
| **Case #3** | `3` | `pay_TXI3fVdh2jU4Nq` | ₹750 | `Payment failed` (Generic) | `RESOLVED` | ✅ Paid (`plink_TXJkz7JK7NjqtM`) | **₹750.00** |
| **Case #4** | `4` | `pay_test_whatsapp_preflight_01` | ₹500 | `Bank switch timeout` | `RECOVERABLE` | ⏳ Active (`plink_7xifK9c`) | **₹0.00** (₹500 at risk) |

- **Total Verified Recovered Revenue**: **₹1,750.00** (175,000 paise) across Cases #1, #2, #3
- **Active Revenue at Risk**: **₹500.00** (50,000 paise) under Case #4
- **Automated Test Coverage**: **498 / 498 tests passing** across **23 test suites**

---

## 3. Milestone 8: Evidence-Driven Failure Intelligence

Milestone 8 replaces generic failure speculation with a strict, evidence-driven **Three-Layer Failure Architecture**. The system clearly separates what the payment provider actually reported from what Revflow infers.

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 1 · PROVIDER SIGNAL (AUTHORITATIVE FACTS)                │
│  Payment Status · Failure Reason · Error Code · Error Source · Error Step · Desc   │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 2 · REVFLOW INTERPRETATION (CANONICAL / AI)              │
│  Deterministic Extraction + Canonical Taxonomy (12 Families) + Advisory AI + Guard│
│  Outputs: Canonical Family · Calibrated Confidence · Grounding Proof · Unknowns   │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 3 · RECOVERY IMPLICATION (POLICY & DECISION)             │
│  Candidate Interventions · Heuristic ERV · 12 Policy Rules · Bounded Execution     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### The Three Layers Explained

1. **Layer 1: Provider Signal (Authoritative Facts)**
   - Normalized directly from webhook payloads without synthetic interpolation.
   - Authoritative fields: `paymentStatus`, `failureReason`, `error_code`, `error_source`, `error_step`, `error_description`, `error_reason`, `payment_method`, and `attempt_count`.
   - Computes mathematical `evidenceStrength` (`STRONG`, `PARTIAL`, `MINIMAL`, `NONE`) and a deterministic `failureSignature` (e.g. `bank|payment_authorization|bad_request_error`).

2. **Layer 2: Revflow Interpretation (Canonical / AI)**
   - Maps evidence into the **12 Canonical Failure Families**:
     - `BANK_SWITCH_TIMEOUT`
     - `GATEWAY_TECHNICAL_FAILURE`
     - `AUTHENTICATION_FAILURE`
     - `INSUFFICIENT_FUNDS`
     - `PAYMENT_METHOD_EXPIRED`
     - `LIMIT_EXCEEDED`
     - `MANDATE_FAILURE`
     - `SUBSCRIPTION_FAILURE`
     - `B2B_RECEIVABLE_DELAY`
     - `CHECKOUT_ABANDONMENT`
     - `PAYMENT_DEGRADATION`
     - `UNKNOWN_FAILURE`
   - **Grounding Proof**: Cites exact verified context keys (`classificationBasis: ['✓ provider.errorCode', '✓ payment.failureReason']`).
   - **Honest Abstention Guard**: If the provider supplies only generic telemetry (e.g. `"Payment failed"`), the engine strictly refuses to invent specific technical claims. It forces:
     - `failureFamily`: `UNKNOWN_FAILURE`
     - `failureType`: `INSUFFICIENT_PROVIDER_TELEMETRY`
     - `confidence`: $\le 0.35$
     - `unknowns`: Explicit checklist of unverified factors (e.g. *"Technical root cause was not verified by provider telemetry"*).

3. **Layer 3: Recovery Implication (Policy & Execution)**
   - Ranks candidate interventions via Expected Recovery Value (ERV).
   - Low confidence ($< 0.65$) deterministically triggers Policy Rule 4 (`confidence_threshold`), routing the case to `REVIEW` and preventing unauthorized autonomous execution.

---

## 4. AI Judgment vs Deterministic Safety

A core requirement in fintech systems is understanding exactly where AI reasoning ends and deterministic execution begins:

```text
                         ┌──────────────────────────────────────────────┐
                         │               INCOMING SIGNALS               │
                         └──────────────────────┬───────────────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
  ┌──────────────────────────────┐                              ┌──────────────────────────────┐
  │       WHERE AI IS USED       │                              │ WHERE DETERMINISTIC RULES WIN│
  │     (Advisory Reasoning)     │                              │   (Authoritative Governance) │
  ├──────────────────────────────┤                              ├──────────────────────────────┤
  │ • Contextual Synthesis       │                              │ • Provider Fact Extraction   │
  │ • Cryptic Error Translation  │                              │ • Financial Calculations (₹) │
  │ • Unknowns Discovery         │                              │ • Canonical Safety Bounds    │
  │ • Root-Cause Explanations    │                              │ • Policy Rules (12 Invariants│
  │ • Next-Best-Action Rationale │                              │ • Stopping Engine (HARD_STOP)│
  │ • Multilingual Copy Creation │                              │ • Provider Verification      │
  │   (English, Hindi, Hinglish) │                              │ • Ledger Reconciliation      │
  └──────────────────────────────┘                              └──────────────────────────────┘
```

### Strict Boundaries
- **AI Never Owns Financial Authority**: The LLM cannot authorize refunds, change recovery amounts, credit ledger balances, or bypass cooldown windows.
- **Server-Owned Amounts**: Every recovery action derives its monetary amount strictly from verified database records in integer paise. The LLM has zero parameter access to specify or alter currency values.
- **No Unproven ML Claims**: Revflow does not claim offline reinforcement learning, black-box deep learning, or autonomous ledger modification. Strategy ranking is powered by an explainable, deterministic ERV heuristic.

---

## 5. Recovery Strategies & Execution Modes

Revflow's strategy registry explicitly categorizes every candidate intervention by its **Execution Mode**. The system never pretends that an internal simulation is a live external integration.

| Strategy ID | Strategy Name | Execution Mode | Provider Integration | Description |
| :--- | :--- | :---: | :---: | :--- |
| `CREATE_PAYMENT_LINK` | Razorpay Payment Link | `LIVE_PROVIDER` | **Razorpay API** | **Live external financial action.** Generates an idempotent Razorpay Payment Link with webhook reconciliation. |
| `SCHEDULE_RETRY_WINDOW` | Smart Retry Window | `SIMULATED` | Internal | Calculates optimal billing retry timing aligned with merchant subscription policies without customer disruption. |
| `CHECKOUT_RECOVERY` | Cart Drop-off Recovery | `SIMULATED` | Internal | Generates preserved checkout session parameters and expiration nudges. |
| `CUSTOMER_OUTREACH` | Customer Notification | `SIMULATED` | Internal / Comm Bridge | Formats contextual recovery notifications across verified channels. |
| `INVOICE_REMINDER` | B2B Invoice Reminder | `SIMULATED` | Internal | Issues corporate accounts receivable reminders referencing agreed commercial terms. |
| `DISPATCH_VERNACULAR_ASSIST` | Vernacular Messaging | `SIMULATED` | Internal | Generates localized Hindi/Hinglish copy to reduce customer authentication hesitation. |
| `RECORD_PROMISE_TO_PAY` | Promise-to-Pay Tracker | `SIMULATED` | Internal | Logs customer payment commitments and pauses active recovery attempts until target date. |
| `REQUEST_MANUAL_REVIEW` | Human Escalation | `CONTROL` | Control Plane | Routes ambiguous, high-value, or low-confidence cases to human operators. Approval cannot override `BLOCK`. |
| `NO_ACTION` | Explicit Abstention | `CONTROL` | Control Plane | Explicitly halts recovery when customer friction or intervention cost exceeds potential recovery value. |

---

## 6. Multi-Playbook Expansion

Four distinct revenue leakage domains operate concurrently over a single unified control plane:

### 1. Payment Degradation (`payment_degradation`)
- **Domain**: Gateway & network transaction failures (`payment.failed`, `payment.authorized`, `payment.captured`).
- **Telemetry**: Error codes, gateway network drops, bank switch timeouts, historical attempt counts.
- **Interventions**: `CREATE_PAYMENT_LINK` (`LIVE_PROVIDER`), `SCHEDULE_RETRY_WINDOW` (`SIMULATED`), `NO_ACTION` (`CONTROL`).

### 2. Checkout Drop-Off (`checkout_drop_off`)
- **Domain**: E-commerce cart abandonment (`checkout.started`, `checkout.drop_off`, `checkout.completed`).
- **Telemetry**: Funnel step reached (`payment_method`, `otp`, `auth`), hesitation duration, cart item count.
- **Interventions**: `CHECKOUT_RECOVERY` (`SIMULATED`), `CREATE_PAYMENT_LINK` (`LIVE_PROVIDER`), `CUSTOMER_OUTREACH` (`SIMULATED`).

### 3. Subscription Recovery (`failed_subscription`)
- **Domain**: Recurring billing & involuntary churn (`subscription.charged`, `subscription.payment_failed`, `subscription.halted`).
- **Telemetry**: Subscription ID, plan tier, billing frequency, consecutive renewal failure count.
- **Interventions**: `SCHEDULE_RETRY_WINDOW` (`SIMULATED`), `CREATE_PAYMENT_LINK` (`LIVE_PROVIDER`), `CUSTOMER_OUTREACH` (`SIMULATED`).

### 4. B2B Receivables (`b2b_receivables`)
- **Domain**: Commercial invoices & accounts receivable (`invoice.created`, `invoice.due`, `invoice.overdue`, `invoice.paid`).
- **Telemetry**: `invoiceId`, `dueDate`, `daysOverdue`, `paymentTerms` (`NET_30`, `NET_60`), dispute status.
- **Interventions**: `INVOICE_REMINDER` (`SIMULATED`), `CREATE_PAYMENT_LINK` (`LIVE_PROVIDER`), `RECORD_PROMISE_TO_PAY` (`SIMULATED`).

---

## 7. Multilingual Recovery & WhatsApp Architecture

Revflow includes a dedicated communication subsystem designed for contextual buyer outreach:

### Implemented Communication Capabilities
- **Multilingual Support**: Contextual recovery copy generation in **English**, **Hindi**, and **Hinglish**.
- **Anti-Hallucination Grounding**: Copy is synthesized strictly from verified server facts (`amountFormatted`, `merchantName`, `paymentLinkUrl`, `brandContext`). If the payment link URL or amount is missing, generation fails closed.
- **Communication Guardrails**:
  - Mandatory 30-minute cooldown quiet period between outreach dispatches.
  - Maximum communication frequency cap (2 attempts per case).
  - Hard-stop on terminal or settled payment events (`PAYMENT_RECOVERED` immediately cancels pending outreach).
  - **Zero Ledger Authority**: Outbound messaging does **not** credit recovered revenue; revenue is recognized only upon provider webhook reconciliation.

### Engineering Honesty: WhatsApp Trial Provider Limitation
During Milestone 7 integration testing against live Twilio infrastructure:
1. The outbound request successfully authenticated with Twilio and reached the API (`https://api.twilio.com/2010-04-01/Accounts/.../Messages.json`).
2. Twilio returned `HTTP 400` with Error Code `21654: "ContentSid Required"`.
3. In Twilio's "Try out WhatsApp" trial sandbox, outbound business-initiated messaging is restricted to pre-approved Content Templates using `ContentSid`, blocking dynamic custom body payloads.

**Honest System Disclosure**:
- Revflow does **not** claim successful physical message delivery to the customer's handset.
- Revflow does **not** claim production readiness for custom body messaging on Twilio trial tiers.
- The control plane gracefully trapped the error, preserved all financial invariants, recorded a `COMMUNICATION_FAILED` audit event, and prevented false recovery claims.

---

## 8. Safety, Governance & Financial Invariants

### The 12 Deterministic Policy Rules
Every proposed intervention must pass through Revflow's deterministic policy engine (`BLOCK ≻ REVIEW ≻ ALLOW`):

| Rule | Policy Rule Name | Guardrail Logic & Rationale | Action on Violation |
| :---: | :--- | :--- | :---: |
| **1** | `context_integrity` | Rejects execution if `paymentId`, `amount`, or `currency` is missing or malformed. | `BLOCK` |
| **2** | `amount_integrity` | Verifies amount $> 0$ and valid integer paise. AI cannot modify amounts. | `BLOCK` |
| **3** | `test_mode_verification` | Asserts provider credentials match `rzp_test_`. Production keys are strictly rejected. | `BLOCK` |
| **4** | `terminal_payment` | Blocks execution if original payment was already captured, settled, or refunded. | `BLOCK` |
| **5** | `case_status` | Halts execution if the case is already `RESOLVED` or `SUPPRESSED`. | `BLOCK` |
| **6** | `resolved_outcome_check` | Asserts no prior recovery outcome has already credited this transaction. | `BLOCK` |
| **7** | `action_allowlist` | Ensures only explicitly registered strategies can execute. | `BLOCK` |
| **8** | `confidence_threshold` | Demands human oversight if AI diagnostic confidence is below 0.65. | `REVIEW` |
| **9** | `max_attempts` | Caps automated recovery at 2 attempts per case to prevent customer harassment. | `REVIEW` |
| **10** | `duplicate_action` | Blocks execution if an active payment link already exists for this case. | `BLOCK` |
| **11** | `high_value_escalation` | Transactions exceeding ₹25,000 require explicit human operator approval. | `REVIEW` |
| **12** | `cooldown_period` | Enforces a mandatory 30-minute quiet period between automated recovery actions. | `REVIEW` |

### Explicit Stopping Engine (`stoppingEngine.js`)
- **`HARD_STOP`**: Halts all processing (`PAYMENT_ALREADY_SETTLED`, `INVOICE_ALREADY_PAID`, `SUBSCRIPTION_CANCELLED`, `MAX_ATTEMPTS_EXCEEDED`).
- **`WAIT`**: Suspends action pending temporal events (`COOLDOWN_ACTIVE` 30m window, `B2B_TERMS_NOT_REACHED`).
- **`ESCALATE`**: Demands human sign-off (`HIGH_VALUE_EXPOSURE`, `COLLECTION_WINDOW_EXPIRED`).
- **`CONTINUE`**: Case is clear to evaluate policy.

### Human Escalation Lifecycle
- Cases flagged for `REVIEW` enter `PENDING_APPROVAL`.
- Operators review via `/api/cases/:id/escalations/approve` or `/reject`.
- **Core Governance Invariant**: Human approval can resolve a `REVIEW`, but **can NEVER override a `BLOCK`**.

### Payment-Scoped Deterministic Reference IDs
To prevent collisions between external payment gateway records and auto-incrementing database sequence IDs:
```text
Format: rc_<caseId>_<paymentToken>_v<attempt>
Example: rc_2_pay_TXHXFLRWrIcSRC_v1 (Length: 26 chars, bounded <= 40)
```
Tying reference IDs to immutable payment tokens guarantees that database resets never collide with historical provider entities.

---

## 9. Engineering Lessons & Failure Containment

1. **PostgreSQL Constraint Alignment During WhatsApp Rollout**:
   - *Problem*: In-memory test suites passed, but live PostgreSQL rejected communication audit records because database check constraints lacked the new action types.
   - *Resolution*: Implemented an idempotent migration script applied automatically at startup, added dedicated `postgresCompatibility.test.js` verification, and proved zero-downtime deployment on Render.
2. **Third-Party Provider Sandbox Boundary**:
   - *Problem*: Outbound WhatsApp communication was blocked by Twilio's trial ContentSid requirement (`Error 21654`).
   - *Resolution*: The engine contained the failure, logged structured diagnostic telemetry without crashing, activated the cooldown timer, and preserved ledger integrity.
3. **Action Initiation vs Ledger Truth**:
   - Generating a link or sending a message is not recovery. Revenue must remain uncredited until an HMAC-signed provider webhook confirms settlement and passes four-point reconciliation.
4. **Fail-Closed AI Integration**:
   - When upstream AI providers experience latency, malformed JSON, or rate limits, Revflow fails closed to human review rather than guessing or executing unauthorized actions.

---

## 10. Technology Stack

- **Runtime & Language**: Node.js `v20+` (ES Modules)
- **Backend Framework**: Express `v5.2.1`
- **Database**: PostgreSQL `v15+` (`pg` driver) with complete fallback to InMemoryRepository for local offline development
- **Validation**: Zod `v4.5.4` schema contracts
- **AI Diagnostics**: Google Gemini / OpenAI-compatible endpoint with strict structured JSON schemas
- **Payments Integration**: Razorpay API (Test Mode) with HMAC-SHA256 webhook verification
- **Frontend Dashboard**: React `18`, Vite `8.2.2`, CSS Variables (responsive, high-density telemetry UI)
- **Testing Framework**: Vitest `4.1.11` (498 tests, 23 test suites)

---

## 11. Local Development & Testing

### Prerequisites
- **Node.js**: `v20.0.0` or higher
- **Package Manager**: `pnpm` (`npm install -g pnpm`)
- **PostgreSQL**: `v15.0+` (optional; memory repository runs automatically if `DATABASE_URL` is omitted)

### 1. Clone & Install
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
Key configuration fields:
```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgres://user:password@localhost:5432/recoverai
RAZORPAY_KEY_ID=rzp_test_your_key
RAZORPAY_KEY_SECRET=your_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
AI_PROVIDER=gemini
AI_MODEL=gemini-2.5-flash
AI_API_KEY=your_gemini_api_key
```

### 3. Run Migrations & Start Servers
```bash
# Apply PostgreSQL migrations (if using Postgres)
pnpm db:migrate

# Terminal 1: Backend API & Autonomous Recovery Worker
pnpm start

# Terminal 2: React Dashboard
pnpm frontend
```
- Backend API: `http://localhost:3001`
- React Frontend: `http://localhost:5173`

### 4. Run Automated Test Suite
```bash
pnpm test
```

#### Verified Test Suite Results (498 / 498 Passing)
```text
 Test Files  23 passed (23)
      Tests  498 passed (498)
   Duration  7.12s
```

All 23 test suites pass with 0 failures:
1. `adversarialFinancialSafety.test.js` (81 adversarial security tests)
2. `autonomyWorker.test.js` (Atomic leasing and background recovery loops)
3. `b2bReceivables.test.js` (B2B invoice recovery and terms evaluation)
4. `batchRecovery.test.js` (High-throughput batch evaluation & provenance)
5. `checkoutDropOff.test.js` (Cart abandonment and drop-off recovery)
6. `communicationEngine.test.js` (Communication lifecycle & cooldowns)
7. `communicationWorker.test.js` (Autonomous communication worker bridge)
8. `diagnosis.test.js` (AI diagnosis, Zod schemas, and fallback adapters)
9. `events.test.js` (Webhook ingestion, normalization, and deduplication)
10. `failureIntelligence.test.js` (Milestone 8 Three-Layer Failure Engine tests)
11. `humanEscalation.test.js` (Approval lifecycle, audit trails, and review gates)
12. `multilingualCommunication.test.js` (Hinglish/Hindi/English copy generation)
13. `outcomeAnalytics.test.js` (Portfolio analytics, velocity, and failure breakdown)
14. `outcomeReconciliation.test.js` (Multi-strategy reconciliation & zero double-counting)
15. `playbookEngine.test.js` (Playbook registration, interface validation, and priority ordering)
16. `playbooksAndEvaluation.test.js` (Integration between playbooks and evaluator)
17. `policyAndExecution.test.js` (The 12 policy rules, idempotency, and bounded execution)
18. `postgresCompatibility.test.js` (PostgreSQL enum and schema constraints)
19. `razorpayWebhook.test.js` (HMAC signature verification and webhook dispatch)
20. `stoppingEngine.test.js` (Explicit STOP, WAIT, ESCALATE, and CONTINUE criteria)
21. `strategyRegistryAndScoring.test.js` (Strategy definitions and heuristic ERV scoring)
22. `subscriptionRecovery.test.js` (Recurring revenue, retry windows, and churn prevention)
23. `whatsappProvider.test.js` (Twilio WhatsApp provider adapter & error handling)

---

## 12. Razorpay Buildathon 2026 Alignment

| Track Requirement | Revflow Implementation | Architectural Proof |
| :--- | :--- | :--- |
| **Track 03: AI Revenue Recovery** | Autonomous multi-playbook recovery control plane for payments, subscriptions, checkout drop-offs, and B2B invoices. | End-to-end recovery loop across 4 distinct business domains. |
| **Grounded AI Diagnostics** | 3-Layer Failure Intelligence Engine separating provider signal from canonical AI interpretation. | Facts cited must strictly match context keys; honest abstention on generic errors. |
| **Financial Safety & Guardrails** | Deterministic 12-rule policy engine with fail-closed human escalation lifecycle. | AI cannot move money; server-owned amounts; human approval cannot override `BLOCK`. |
| **Closed-Loop Reconciliation** | Multi-key provider webhook verification ensuring truthful ledger attribution without double counting. | HMAC-SHA256 signature verification; ₹1,750 verified recovered in live test mode. |
| **Production Resilience** | PostgreSQL schema migration idempotency, length-bounded reference IDs, and failure containment. | Zero-downtime deployment on Render; 498/498 automated tests passing. |

---

**Live Production Dashboard**: [https://revflow.onrender.com](https://revflow.onrender.com)
**Project Repository**: [https://github.com/gititayush/recover-ai](https://github.com/gititayush/recover-ai)
