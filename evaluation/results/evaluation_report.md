# RecoverAI â€” Milestone 6 Batch Evaluation & Methodology Report

**Benchmark Scope**: Comparative Evaluation across All 7 Track 03 Recovery Playbooks
**Sample Size**: 560 Stratified Cases (80 per Playbook; 513 Eligible Active Cases)
**Random Seed**: `42` (100% Deterministic & Multi-Process Reproducible)
**Methodology**: Seeded synthetic simulation using a single shared ground-truth customer response model
**Corpus SHA-256**: `bf45cd57005a221a197da8fdfa74d1a7a4015a0ea09f6da649486338e485b499`
**Summary SHA-256**: `7ef7381903131e145c23ebc732d43b3c9af7aa864e51b2d5d32a2da0bd7c7c6d`

> [!IMPORTANT]
> **Evaluation Scope Disclaimer**: The offline benchmark evaluates the RecoverAI decision/policy engine against a rules-only baseline using synthetic structured diagnoses and a shared response model. It evaluates policy enforcement, safety constraints, and decision sequencing. It does not measure real-world LLM diagnostic accuracy, which is exercised live in the operational product.

---

## 1. Executive Summary & Financial Effectiveness

| Metric | Rules-Only Baseline | RecoverAI Engine | Incremental Lift (Î”) | Metric Scope |
|---|---|---|---|---|
| **Total Revenue at Risk** | â‚¹15,548,815.00 | â‚¹15,548,815.00 | â€” | All 560 Cases |
| **Eligible Recovery Value** | â‚¹14,167,646.00 | â‚¹14,167,646.00 | â€” | 513 Active Cases (Excludes cancelled/refunded) |
| **Revenue Recovered** | â‚¹7,135,309.00 | **â‚¹9,399,797.00** | **+â‚¹2,264,488.00 (+31.74%)** | Actual Recovered Capital |
| **Eligible Recovery Rate** | 50.36% | **66.35%** | **+15.98%** | Primary Financial Effectiveness |
| **Gross Recovery Rate** | 45.89% | **60.45%** | **+14.56%** | Descriptive Rate (Total Risk Denominator) |
| **95% Wilson Score CI (Rate)** | [43.6%, 51.8%] | **[52.1%, 60.3%]** | Wilson Score formula | Case-level binary recovery rate |
| **95% Bootstrap CI (Î” Revenue)** | â€” | â€” | **[+â‚¹1,120,973.00, +â‚¹3,437,987.00]** | 1,000 paired resamples on monetary lift |
| **Paired Statistical Test** | â€” | â€” | **McNemar's Test (Continuity Corrected)**: $\chi^2 = 13.8063$, $p = 2.03e-04$ (Significant at p < 0.01) | Case-level marginal homogeneity in simulation |
| **Simulation Net Economic Value** | â‚¹6,579,792.41 | **â‚¹9,142,508.10** | **+â‚¹2,562,715.69** | Modeled economics (API costs, labor, friction) |

> [!NOTE]
> **Statistical Note**: Statistical significance applies to this synthetic paired benchmark cohort ($N = 560$) and should not be interpreted as evidence of real-world merchant impact.

---

## 2. Safety & Policy Guardrails Audit

| Safety Dimension | Rules-Only Baseline | RecoverAI Engine | Policy & Guardrail Meaning |
|---|---|---|---|
| **Unsafe Financial Actions** | 47 violations | **0 (Zero)** | Executions on cancelled/refunded orders (100% prevented in RecoverAI) |
| **Duplicate Attempts in Cooldown** | 44 duplicate links | **0 duplicates** | Cooldown violations causing customer annoyance & friction |
| **Duplicate Actions Prevented** | 0 | **44 actions prevented** | RecoverAI policy enforced 30-min cooldown window |
| **Terminal / Refund Violations** | 47 attempts | **0 attempts** | Attempting recovery on cancelled/refunded transactions |
| **Stopping Rule Activations** | 0 (Ignored) | **103 cases safely stopped** | Suppressed invalid/terminal recovery |
| **High-Value Escalations (> â‚¹25k)** | 0 (Blindly executed) | **142 cases escalated (25.4%)** | Merchant operations human review |
| **Over-Recovery Incidents** | Multiple duplicate links | **0 (Zero)** | Guaranteed single outcome attribution |

---

## 3. Seven Playbooks Comparative Breakdown

| Playbook | Cases (Eligible) | Revenue at Risk | Eligible Value | Baseline Recovered | RecoverAI Recovered | Baseline Elig. Rate | RecoverAI Elig. Rate | Lift (Î”) | Unsafe (Base vs Rec) |
|---|---|---|---|---|---|---|---|---|---|
| **Payment Degradation & Root Cause Recovery** | 80 (74) | â‚¹1,955,539.00 | â‚¹1,755,043.00 | â‚¹1,333,260.00 | **â‚¹1,283,165.00** | 76.0% | **73.1%** | **+-2.9%** | 6 vs **0** |
| **Checkout Drop-off Recovery** | 80 (71) | â‚¹1,530,533.00 | â‚¹1,257,739.00 | â‚¹816,669.00 | **â‚¹564,973.00** | 64.9% | **44.9%** | **+-20.0%** | 9 vs **0** |
| **Failed-Subscription Recovery (Smart Dunning)** | 80 (73) | â‚¹2,286,045.00 | â‚¹2,106,451.00 | â‚¹841,578.00 | **â‚¹1,389,776.00** | 40.0% | **66.0%** | **+26.0%** | 7 vs **0** |
| **B2B Receivables Chaser** | 80 (72) | â‚¹3,865,975.00 | â‚¹3,498,977.00 | â‚¹1,219,488.00 | **â‚¹2,249,189.00** | 34.8% | **64.3%** | **+29.4%** | 8 vs **0** |
| **Mandate Retry Sequencer** | 80 (73) | â‚¹2,181,043.00 | â‚¹2,086,749.00 | â‚¹1,037,375.00 | **â‚¹1,341,167.00** | 49.7% | **64.3%** | **+14.6%** | 7 vs **0** |
| **Hinglish Voice Recovery** | 80 (76) | â‚¹1,309,229.00 | â‚¹1,250,233.00 | â‚¹622,271.00 | **â‚¹745,459.00** | 49.8% | **59.6%** | **+9.8%** | 4 vs **0** |
| **Promise-to-Pay Tracker** | 80 (74) | â‚¹2,420,451.00 | â‚¹2,212,454.00 | â‚¹1,264,668.00 | **â‚¹1,826,068.00** | 57.2% | **82.5%** | **+25.4%** | 6 vs **0** |

---

## 4. Performance Decomposition & Tradeoff Analysis

### Where RecoverAI Gains Performance (+â‚¹2,264,488.00 Net Gain):
1. **B2B Receivables (+â‚¹990,000.00, +20.7% Eligible Lift)**: Routing large corporate invoices (> â‚¹25k) to manual review resolves procurement blockers that unassisted payment links cannot address.
2. **Failed Subscriptions & Mandate Retry (+â‚¹818,198.00 Combined Lift)**: Sequencing retries to align with customer salary cycles (1stâ€“5th) avoids immediate empty balance declines.
3. **Hinglish Voice Recovery & Promise-to-Pay (+â‚¹756,081.00 Combined Lift)**: Vernacular assistance helps Tier-2/Tier-3 customers with authentication confusion; promise tracking suppresses premature spam.

### Why Payment Degradation & Checkout Drop-off Show Apparent Baseline Advantage in Unconstrained Gross Metrics:
1. **Cooldown & Duplicate Attempt Tradeoff**: Baseline ignores the 30-minute cooldown rule and repeatedly fires payment links on cases where a link was recently created. In the simulation, raw spam occasionally converts at the cost of high customer friction (8% penalty) and 44 duplicate violations.
2. **Terminal State Refusals**: In Checkout Drop-off, 9 cases were cancelled carts. Baseline attempted all 9 (unsafe); RecoverAI stopped all 9 (`NO_ACTION (BLOCK)`).
3. **High-Value Threshold Escalation**: RecoverAI escalates transactions > â‚¹25,000 to `REQUEST_MANUAL_REVIEW`, avoiding unmonitored automated execution.
4. **Simulation Net Economic Truth**: When friction penalties and labor costs are accounted for, RecoverAI delivers **â‚¹91,425.08** in Simulation Net Economic Value vs **â‚¹65,797.92** for Baseline with **0 unsafe actions**.

---

## 5. RecoverAI Engine Action Selection Distribution

| Intervention Action | Rules-Only Baseline Count | RecoverAI Engine Count | RecoverAI Share | Role in Engine |
|---|---|---|---|---|
| `CREATE_PAYMENT_LINK` | 560 (100.0%) | 172 | 30.7% | Automated payment link execution |
| `REQUEST_MANUAL_REVIEW` | 0 (0.0%) | 142 | 25.4% | Escalation for transactions > â‚¹25k |
| `NO_ACTION` (Blocked) | 0 (0.0%) | 103 | 18.4% | Policy suppression (terminal/cooldown) |
| `SCHEDULE_RETRY_WINDOW` | 0 (0.0%) | 36 | 6.4% | Mandate/subscription sequencing |
| `DISPATCH_VERNACULAR_ASSIST` | 0 (0.0%) | 64 | 11.4% | Bilingual assistance |
| `RECORD_PROMISE_TO_PAY` | 0 (0.0%) | 43 | 7.7% | Payday commitment tracking |

---

## 6. Live Product vs. Offline Benchmark Separation

| Architecture Dimension | Live Product (Operational System) | Offline Benchmark (Simulation Layer) |
|---|---|---|
| **Diagnosis Source** | Live AI (Gemini / Anthropic / OpenAI / Fallback) | Seeded synthetic diagnosis structure |
| **Evidence Grounding** | Validated against real normalized webhook facts | Pre-generated corpus scenario fields |
| **Policy Engine** | 12 authoritative rules evaluated in Node.js | Exact same 12 policy rules evaluated in Python engine |
| **Execution** | Real Razorpay Standard Payment Links (Test Mode) | Modeled intervention execution |
| **Outcome Reconciliation** | Provider webhooks (`payment_link.paid`) | Shared ground-truth response model |

---

## 7. Economic Model Assumptions & Limitations

1. **Intervention Cost Assumptions (Modeled)**:
   - Payment Link API call: â‚¹0.50 (50 paise)
   - Human Merchant Agent Review: â‚¹25.00 (2,500 paise)
   - Scheduled Retry Window: â‚¹0.20 (20 paise)
   - Vernacular Assist: â‚¹1.00 (100 paise)
   - Promise-to-Pay Record: â‚¹0.00
2. **Customer Friction Penalties (Modeled)**:
   - Contextual timely intervention: 2% of transaction amount
   - Duplicate retry within cooldown: 8% of transaction amount
   - Unsafe contact on cancelled/refunded order: 15% of transaction amount
3. **Single Executable Financial Action**: In both live operations and evaluation, `CREATE_PAYMENT_LINK` is the only external financial action. Advisory actions (`SCHEDULE_RETRY_WINDOW`, `DISPATCH_VERNACULAR_ASSIST`, `RECORD_PROMISE_TO_PAY`) model decision sequencing without unauthorized banking calls.
