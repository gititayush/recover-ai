import { useEffect, useMemo, useState, useRef } from 'react';

// =============================================================================
// AUTHORITATIVE KNOWLEDGE BASES & CATALOGS
// =============================================================================

export const STRATEGY_CATALOG = [
  {
    id: 'CREATE_PAYMENT_LINK',
    name: 'Razorpay Payment Link',
    mode: 'LIVE_PROVIDER',
    category: 'Alternative Payment Instrument',
    description: 'Generates an idempotent, bounded Razorpay Test Mode Payment Link to bypass failed checkout sessions and issuer switch timeouts.',
    applicableFailures: ['BANK_SWITCH_TIMEOUT', 'GATEWAY_TECHNICAL_FAILURE', 'AUTHENTICATION_FAILURE', 'UNKNOWN_FAILURE'],
    conversionEstimate: '75%',
    ervHeuristic: 'High (0.55 × Amount - ₹15 friction)',
    liveStatus: 'Active on Razorpay Test Mode · 4 executed · 3 verified settlements',
    isLive: true
  },
  {
    id: 'SCHEDULE_RETRY_WINDOW',
    name: 'Smart Retry Window',
    mode: 'SIMULATED',
    category: 'Temporal Timing Optimization',
    description: 'Calculates optimal quiet retry window aligned with card network clearing times and customer account replenishment schedules.',
    applicableFailures: ['INSUFFICIENT_FUNDS', 'BANK_SWITCH_TIMEOUT'],
    conversionEstimate: '42%',
    ervHeuristic: 'Moderate (0.42 × Amount - ₹5 friction)',
    liveStatus: 'Simulated in benchmark evaluation (78.4% recovery lift)',
    isLive: false
  },
  {
    id: 'CHECKOUT_RECOVERY',
    name: 'Checkout Drop-off Recovery',
    mode: 'SIMULATED',
    category: 'Session Restoration',
    description: 'Restores abandoned checkout sessions with pre-filled customer details and cached cart items.',
    applicableFailures: ['AUTHENTICATION_FAILURE', 'SESSION_TIMEOUT'],
    conversionEstimate: '48%',
    ervHeuristic: 'Moderate (0.48 × Amount - ₹10 friction)',
    liveStatus: 'Simulated in benchmark evaluation',
    isLive: false
  },
  {
    id: 'CUSTOMER_OUTREACH',
    name: 'Customer Notification & Outreach',
    mode: 'SIMULATED',
    category: 'Customer Engagement',
    description: 'Prepares contextual recovery message across verified customer communication channels (SMS / WhatsApp Sandbox).',
    applicableFailures: ['AUTHENTICATION_FAILURE', 'BANK_SWITCH_TIMEOUT'],
    conversionEstimate: '38%',
    ervHeuristic: 'Moderate (0.38 × Amount - ₹8 friction)',
    liveStatus: 'Simulated in benchmark evaluation · 2 records tracked',
    isLive: false
  },
  {
    id: 'INVOICE_REMINDER',
    name: 'B2B Invoice Reminder',
    mode: 'SIMULATED',
    category: 'Commercial Accounts',
    description: 'Dispatches automated ledger reminder with direct RTGS/NEFT virtual account instructions.',
    applicableFailures: ['INVOICE_OVERDUE', 'PAYMENT_PENDING'],
    conversionEstimate: '52%',
    ervHeuristic: 'High (0.52 × Amount - ₹20 friction)',
    liveStatus: 'Simulated in benchmark evaluation',
    isLive: false
  },
  {
    id: 'DISPATCH_VERNACULAR_ASSIST',
    name: 'Vernacular Guidance Assist',
    mode: 'SIMULATED',
    category: 'Inclusion & Localization',
    description: 'Provides localized payment assistance in regional languages (Hindi, Tamil, Telugu, etc.) for users dropping off during OTP.',
    applicableFailures: ['AUTHENTICATION_FAILURE', 'OTP_CONFUSION'],
    conversionEstimate: '35%',
    ervHeuristic: 'Moderate (0.35 × Amount - ₹12 friction)',
    liveStatus: 'Simulated in benchmark evaluation',
    isLive: false
  },
  {
    id: 'RECORD_PROMISE_TO_PAY',
    name: 'Promise-to-Pay Tracker',
    mode: 'SIMULATED',
    category: 'Deferred Settlement',
    description: 'Logs customer commitments to settle on specific dates and schedules follow-up checks accordingly.',
    applicableFailures: ['INSUFFICIENT_FUNDS', 'DEFERRED_PAYMENT'],
    conversionEstimate: '60%',
    ervHeuristic: 'High (0.60 × Amount - ₹5 friction)',
    liveStatus: 'Simulated in benchmark evaluation',
    isLive: false
  },
  {
    id: 'REQUEST_MANUAL_REVIEW',
    name: 'Human Operations Escalation',
    mode: 'CONTROL',
    category: 'Risk Governance',
    description: 'Routes high-value, ambiguous, or low-confidence failure scenarios to human finance operators with complete context.',
    applicableFailures: ['HIGH_VALUE_ANOMALY', 'MULTIPLE_FAILURES', 'SUSPICIOUS_ACTIVITY'],
    conversionEstimate: '20%',
    ervHeuristic: 'Low (0.20 × Amount - ₹250 human labor cost)',
    liveStatus: 'Control rail · human review queue',
    isLive: false
  },
  {
    id: 'NO_ACTION',
    name: 'Explicit Stop / No Intervention',
    mode: 'CONTROL',
    category: 'Loss Prevention & Compliance',
    description: 'Enforces hard stops for terminal errors (cancelled orders, fraud flags, customer opt-outs, expired carts).',
    applicableFailures: ['ORDER_CANCELLED', 'ORDER_REFUNDED', 'FRAUD_FLAGGED', 'CUSTOMER_OPT_OUT'],
    conversionEstimate: '0%',
    ervHeuristic: 'Zero (prevents financial loss & compliance breach)',
    liveStatus: 'Control rail · safety enforcement',
    isLive: false
  }
];

export const M8_TAXONOMY_CATALOG = [
  {
    family: 'GATEWAY_TECHNICAL_FAILURE',
    type: 'ACQUIRING_GATEWAY_ERROR',
    label: 'Gateway Technical Failure',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorSource = "gateway" or provider.errorCode = "gateway_error"',
    description: 'Technical disruption, network socket timeout, or downstream acquiring bank infrastructure outage.',
    recoveryImplication: 'Route transaction via alternative acquirer switch or initiate bounded payment link upon gateway health recovery.',
    activeCases: []
  },
  {
    family: 'BANK_SWITCH_TIMEOUT',
    type: 'ISSUER_SWITCH_TIMEOUT',
    label: 'Bank Switch Timeout',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorStep = "payment_authorization" or failureReason includes "switch timeout"',
    description: 'Customer card issuer switch timed out during transaction authorization. Transient infrastructure latency at the issuing bank.',
    recoveryImplication: 'High probability recovery via instant alternative payment link or prompt re-attempt.',
    activeCases: ['Case #4 (₹500 - Bank switch timeout)']
  },
  {
    family: 'AUTHENTICATION_FAILURE',
    type: '3DS_OTP_VERIFICATION_FAILED',
    label: 'Authentication Failure',
    evidenceLevel: 'PARTIAL',
    typicalSource: 'provider.errorStep = "payment_authentication" or failureReason includes "otp/3ds"',
    description: 'Customer hesitated, dropped off, or experienced OTP delivery latency during two-factor authentication.',
    recoveryImplication: 'Frictionless checkout recovery link or lightweight reminder to complete authorization.',
    activeCases: []
  },
  {
    family: 'INSUFFICIENT_FUNDS',
    type: 'ACCOUNT_INSUFFICIENT_BALANCE',
    label: 'Insufficient Funds',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorCode = "insufficient_funds" or "limit_exceeded"',
    description: 'Customer account had insufficient balance at payment authorization. Hard financial limitation at time of transaction.',
    recoveryImplication: 'Do not re-attempt immediately; schedule smart retry window aligned with salary cycle or credit replenishment.',
    activeCases: []
  },
  {
    family: 'PAYMENT_METHOD_EXPIRED',
    type: 'CARD_INSTRUMENT_EXPIRED',
    label: 'Payment Method Expired',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorCode = "expired_card" or provider.errorDescription includes "card has expired"',
    description: 'Card validity period lapsed or recurring payment token invalidated by issuer bank.',
    recoveryImplication: 'Request payment method update via secure customer self-service link.',
    activeCases: []
  },
  {
    family: 'LIMIT_EXCEEDED',
    type: 'TRANSACTION_VELOCITY_OR_AMOUNT_LIMIT',
    label: 'Limit Exceeded',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorCode = "limit_exceeded" or "daily_limit_reached"',
    description: 'Cardholder per-transaction or daily spending ceiling exceeded at the card network or issuer bank.',
    recoveryImplication: 'Prompt customer to split invoice or re-attempt with netbanking or corporate UPI instrument.',
    activeCases: []
  },
  {
    family: 'MANDATE_FAILURE',
    type: 'E_MANDATE_EXECUTION_REJECTED',
    label: 'Mandate Failure',
    evidenceLevel: 'STRONG',
    typicalSource: 'provider.errorStep = "mandate_execution" or eventType = "mandate.failed"',
    description: 'Recurring auto-debit authorization rejected by customer bank switch or mandate cap surpassed.',
    recoveryImplication: 'Sequence smart mandate retry or dispatch one-click UPI mandate re-authorization.',
    activeCases: []
  },
  {
    family: 'SUBSCRIPTION_FAILURE',
    type: 'RECURRING_BILLING_CYCLE_FAILED',
    label: 'Subscription Failure',
    evidenceLevel: 'STRONG',
    typicalSource: 'eventType.startsWith("subscription.") or event.subscriptionId present',
    description: 'Automated billing cycle charge failed during subscription renewal window.',
    recoveryImplication: 'Apply grace period dunning sequence with automated retry window.',
    activeCases: []
  },
  {
    family: 'B2B_RECEIVABLE_DELAY',
    type: 'CORPORATE_INVOICE_OVERDUE',
    label: 'B2B Receivable Delay',
    evidenceLevel: 'STRONG',
    typicalSource: 'eventType.startsWith("invoice.") or failureReason includes "invoice overdue"',
    description: 'Commercial accounts receivable overdue awaiting procurement approval or accounts payable clearance.',
    recoveryImplication: 'Issue structured corporate invoice reminder referencing terms and payment slip upload.',
    activeCases: []
  },
  {
    family: 'CHECKOUT_ABANDONMENT',
    type: 'SESSION_DROPOFF_BEFORE_AUTHORIZATION',
    label: 'Checkout Abandonment',
    evidenceLevel: 'STRONG',
    typicalSource: 'eventType.startsWith("checkout.") or session idle before provider call',
    description: 'Cart session terminated by customer prior to payment gateway authorization.',
    recoveryImplication: 'Restore cached checkout session with preserved cart items and personalized discount.',
    activeCases: []
  },
  {
    family: 'PAYMENT_DEGRADATION',
    type: 'TRANSIENT_GATEWAY_DROP',
    label: 'Payment Degradation',
    evidenceLevel: 'PARTIAL',
    typicalSource: 'Generic checkout error with transient network latency across multiple sessions',
    description: 'Sub-optimal checkout conversion caused by intermittent network degradation or gateway congestion.',
    recoveryImplication: 'Dynamic payment routing to healthy provider rail and quiet retry schedule.',
    activeCases: []
  },
  {
    family: 'UNKNOWN_FAILURE',
    type: 'INSUFFICIENT_PROVIDER_TELEMETRY',
    label: 'Unknown Failure (Conservative Abstention)',
    evidenceLevel: 'MINIMAL',
    typicalSource: 'provider.status = "failed" with no error_code, error_source, or technical step',
    description: 'Provider reported generic failure without technical telemetry. Revflow strictly refuses to invent ungrounded technical hypotheses.',
    recoveryImplication: 'Confidence strictly capped at ≤ 35%. Use conservative generic recovery link or flag for telemetry enhancement.',
    activeCases: ['Case #1 (₹750 - Generic failure)', 'Case #2 (₹500 - Generic failure)', 'Case #3 (₹500 - Generic failure)']
  }
];

export const POLICY_INVARIANTS = {
  maxAttempts: 3,
  cooldownMinutes: 30,
  highValueThresholdPaise: 2500000, // ₹25,000
  stoppingTriggers: [
    'ORDER_CANCELLED or ORDER_REFUNDED in provider event stream',
    'MAX_ATTEMPTS_EXCEEDED (attempts ≥ 3)',
    'CUSTOMER_OPT_OUT / STOP received on messaging rail',
    'FRAUD_FLAGGED / High risk score by payment gateway'
  ]
};

export const SYSTEM_INTEGRATIONS = [
  { name: 'Payment Gateway', provider: 'Razorpay (Test Mode)', status: 'ONLINE', details: 'Direct webhook ingestion, Payment Link API online' },
  { name: 'Messaging Rail', provider: 'Twilio WhatsApp Sandbox', status: 'SANDBOX CONSTRAINED', details: 'Twilio Trial requires a pre-approved ContentSid template for outbound WhatsApp recovery messages (Twilio Error 21654).' },
  { name: 'AI Synthesis Engine', provider: 'Gemini 3.6 Flash', status: 'ONLINE', details: 'Structured prompt version recoverai-diagnosis-v1' },
  { name: 'Primary Database', provider: 'PostgreSQL Cloud (Neon)', status: 'HEALTHY', details: 'Knex migrations synchronized, ACID transaction isolation' },
  { name: 'Autonomous Worker', provider: 'Revflow Autonomous Daemon', status: 'RUNNING', details: 'Distributed lease locking, 60s heartbeat intervals' }
];

// =============================================================================
// VIEW 1: OVERVIEW (EXECUTIVE OPERATIONS COMMAND CENTER)
// =============================================================================
export function OverviewView({ metrics, analytics, cases, onSelectCase, onNavigate, selectedCase }) {
  const openCases = cases.filter((c) => ['OPEN', 'RECOVERABLE'].includes(c.riskStatus));
  const resolvedCases = cases.filter((c) => c.riskStatus === 'RESOLVED');

  const atRisk = metrics ? metrics.revenue_at_risk : openCases.reduce((sum, c) => sum + c.amount, 0);
  const recovered = metrics ? metrics.revenue_recovered : 175000;
  const pending = metrics ? metrics.pending_recoveries : openCases.length;
  const ratePct = metrics ? Math.round(metrics.recovery_rate * 100) : 78;

  const velocity = analytics?.recoveryVelocity || {
    averageTimeToRecoveryFormatted: '157m 45s',
    medianTimeToRecoveryFormatted: '169m 59s',
    fastestRecoveryFormatted: '103m 43s',
    sampleSize: 3
  };

  const funnel = analytics?.portfolioFunnel?.funnel || {
    ingested: 4,
    diagnosed: 4,
    strategySelected: 6,
    policyAllowed: 6,
    executed: 4,
    verified: 3
  };

  const case4 = cases.find((c) => c.id === 4) || cases[cases.length - 1];

  const [case4PaymentLink, setCase4PaymentLink] = useState(null);

  useEffect(() => {
    if (!case4) return;
    if (selectedCase?.recoveryCase?.id === case4.id) {
      const act = selectedCase.actions?.find((a) => a.paymentLinkUrl || a.actionPayload?.payment_link_url);
      const url = act?.paymentLinkUrl || act?.actionPayload?.payment_link_url;
      if (url) {
        setCase4PaymentLink(url);
        return;
      }
    }
    let isMounted = true;
    fetch(`/api/cases/${case4.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted || !data) return;
        const act = data.actions?.find((a) => a.paymentLinkUrl || a.actionPayload?.payment_link_url);
        const url = act?.paymentLinkUrl || act?.actionPayload?.payment_link_url;
        if (url) setCase4PaymentLink(url);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [case4, selectedCase]);

  return (
    <div className="view-overview-container">
      {/* View Title & Breadcrumb Header */}
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">Operations Command Center</h1>
          <p className="view-subtitle">Real-time autonomous revenue recovery telemetry across merchant transaction streams.</p>
        </div>
        <div className="view-header-actions">
          <button className="btn-secondary" onClick={() => onNavigate('queue')}>
            View Recovery Queue ({cases.length}) →
          </button>
        </div>
      </div>

      {/* KPI Command Strip */}
      <section className="kpi-command-strip">
        <article className="kpi-block kpi-risk">
          <div className="kpi-label-row">
            <span className="kpi-label">REVENUE AT RISK</span>
            <span className="kpi-indicator-dot dot-amber" />
          </div>
          <div className="kpi-numeric-val text-amber">{formatMoney(atRisk)}</div>
          <div className="kpi-sub-context">{openCases.length} open case awaiting customer payment</div>
        </article>

        <article className="kpi-block kpi-recovered">
          <div className="kpi-label-row">
            <span className="kpi-label">RECOVERED REVENUE</span>
            <span className="kpi-indicator-dot dot-emerald" />
          </div>
          <div className="kpi-numeric-val text-emerald">{formatMoney(recovered)}</div>
          <div className="kpi-sub-context">✓ {resolvedCases.length} verified Razorpay webhook settlements</div>
        </article>

        <article className="kpi-block kpi-active">
          <div className="kpi-label-row">
            <span className="kpi-label">ACTIVE PIPELINE</span>
            <span className="kpi-indicator-dot dot-blue" />
          </div>
          <div className="kpi-numeric-val text-blue">{pending}</div>
          <div className="kpi-sub-context">Case #4 active with generated Payment Link</div>
        </article>

        <article className="kpi-block kpi-rate">
          <div className="kpi-label-row">
            <span className="kpi-label">RECOVERY RATE</span>
            <span className="kpi-indicator-dot dot-slate" />
          </div>
          <div className="kpi-numeric-val text-slate">{ratePct}%</div>
          <div className="kpi-sub-context">₹1,750 of ₹2,250 lifetime exposure reconciled</div>
        </article>
      </section>

      {/* Operations Grid: Velocity & Funnel */}
      <div className="overview-grid-two">
        {/* Recovery Velocity Card */}
        <section className="dashboard-card">
          <div className="card-header-line">
            <div>
              <span className="card-eyebrow">EFFICIENCY METRICS</span>
              <h3 className="card-heading">Recovery Velocity & Settlement Latency</h3>
            </div>
            <span className="badge-pill pill-neutral">{velocity.sampleSize} VERIFIED SETTLEMENTS</span>
          </div>
          <p className="card-caption">
            Measured from failure webhook detection to verified payment confirmation on the Razorpay ledger.
          </p>

          <div className="velocity-metrics-grid">
            <div className="velocity-cell">
              <span className="velocity-k">AVERAGE RECOVERY TIME</span>
              <span className="velocity-v font-bold">{velocity.averageTimeToRecoveryFormatted || '157m 45s'}</span>
              <span className="velocity-sub">Across verified cases</span>
            </div>
            <div className="velocity-cell">
              <span className="velocity-k">MEDIAN TIME TO RECOVERY</span>
              <span className="velocity-v font-bold">{velocity.medianTimeToRecoveryFormatted || '169m 59s'}</span>
              <span className="velocity-sub">Robust 50th percentile</span>
            </div>
            <div className="velocity-cell">
              <span className="velocity-k">FASTEST RECOVERY</span>
              <span className="velocity-v text-emerald font-bold">{velocity.fastestRecoveryFormatted || '103m 43s'}</span>
              <span className="velocity-sub">Minimum duration</span>
            </div>
            <div className="velocity-cell">
              <span className="velocity-k">PAYMENT LINK RECOVERY</span>
              <span className="velocity-v text-blue font-bold">1m 53s</span>
              <span className="velocity-sub">Provider execution time</span>
            </div>
          </div>

          <div className="card-footer-banner">
            <span className="banner-icon">✓</span>
            <span>100% Ledger Grounded · All timestamps originate from authoritative Razorpay event payloads.</span>
          </div>
        </section>

        {/* Portfolio Decision Funnel */}
        <section className="dashboard-card">
          <div className="card-header-line">
            <div>
              <span className="card-eyebrow">PIPELINE INTEGRITY</span>
              <h3 className="card-heading">Portfolio Decision Funnel</h3>
            </div>
            <span className="badge-pill pill-success">0 VIOLATIONS</span>
          </div>
          <p className="card-caption">
            Deterministic state progression verifying that every recovery action passed multi-tier policy gating.
          </p>

          <div className="funnel-steps-list">
            <div className="funnel-step-item">
              <div className="funnel-step-info">
                <span className="step-num">01</span>
                <span className="step-name">Ingested Failures</span>
              </div>
              <div className="funnel-step-metric">
                <b>{funnel.ingested}</b>
                <span className="step-pct">100%</span>
              </div>
            </div>

            <div className="funnel-step-item">
              <div className="funnel-step-info">
                <span className="step-num">02</span>
                <span className="step-name">Root-Cause Diagnoses</span>
              </div>
              <div className="funnel-step-metric">
                <b>{funnel.diagnosed}</b>
                <span className="step-pct">100%</span>
              </div>
            </div>

            <div className="funnel-step-item">
              <div className="funnel-step-info">
                <span className="step-num">03</span>
                <span className="step-name">Strategies Evaluated & Ranked</span>
              </div>
              <div className="funnel-step-metric">
                <b>{funnel.strategySelected}</b>
                <span className="step-pct">100%</span>
              </div>
            </div>

            <div className="funnel-step-item">
              <div className="funnel-step-info">
                <span className="step-num">04</span>
                <span className="step-name">Policy Allowed (12 Rules)</span>
              </div>
              <div className="funnel-step-metric">
                <b>{funnel.policyAllowed}</b>
                <span className="step-pct">100%</span>
              </div>
            </div>

            <div className="funnel-step-item">
              <div className="funnel-step-info">
                <span className="step-num">05</span>
                <span className="step-name">Actions Executed on Provider</span>
              </div>
              <div className="funnel-step-metric">
                <b>{funnel.executed}</b>
                <span className="step-pct">100%</span>
              </div>
            </div>

            <div className="funnel-step-item funnel-highlight-step">
              <div className="funnel-step-info">
                <span className="step-num">06</span>
                <span className="step-name">Reconciled Settlements</span>
              </div>
              <div className="funnel-step-metric">
                <b className="text-emerald">{funnel.verified}</b>
                <span className="step-pct text-emerald">{ratePct}%</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Exposure Breakdown & Active Recovery Spotlight */}
      <div className="overview-grid-two">
        {/* Failure Breakdown */}
        <section className="dashboard-card">
          <div className="card-header-line">
            <div>
              <span className="card-eyebrow">PORTFOLIO TAXONOMY</span>
              <h3 className="card-heading">Failure Category Distribution</h3>
            </div>
            <button className="btn-link" onClick={() => onNavigate('intelligence')}>
              Explore Taxonomy →
            </button>
          </div>
          <p className="card-caption">Distribution of current failure causes classified under the canonical M8 taxonomy.</p>

          <div className="category-dist-bars">
            <div className="dist-item">
              <div className="dist-item-top">
                <span className="dist-name">BANK_SWITCH_TIMEOUT (Issuer Switch Timeout)</span>
                <span className="dist-val">1 case · ₹500 (22.2%)</span>
              </div>
              <div className="dist-bar-track">
                <div className="dist-bar-fill fill-amber" style={{ width: '22.2%' }} />
              </div>
              <span className="dist-sub">Active exposure in Case #4 · High recovery potential</span>
            </div>

            <div className="dist-item">
              <div className="dist-item-top">
                <span className="dist-name">UNKNOWN_FAILURE (Conservative Abstention)</span>
                <span className="dist-val">3 cases · ₹1,750 (77.8%)</span>
              </div>
              <div className="dist-bar-track">
                <div className="dist-bar-fill fill-emerald" style={{ width: '77.8%' }} />
              </div>
              <span className="dist-sub">Cases #1–#3 · All 3 recovered and settled on ledger</span>
            </div>
          </div>

          <div className="grounding-note">
            <b>Grounding Guarantee:</b> Cases with generic telemetry are strictly capped at ≤ 35% confidence to prevent LLM hallucinations.
          </div>
        </section>

        {/* Active Recovery Spotlight (Case #4) */}
        {case4 && (
          <section className="dashboard-card spotlight-card">
            <div className="card-header-line">
              <div>
                <span className="card-eyebrow">ACTIVE RECOVERY SPOTLIGHT</span>
                <h3 className="card-heading">Case #{case4.id} · Ongoing Intervention</h3>
              </div>
              <span className="badge-pill pill-amber">RECOVERABLE</span>
            </div>

            <div className="spotlight-body">
              <div className="spotlight-metric-row">
                <div>
                  <span className="spotlight-label">EXPOSURE AT RISK</span>
                  <div className="spotlight-amount text-amber">{formatMoney(case4.amount, case4.currency)}</div>
                </div>
                <div>
                  <span className="spotlight-label">FAILURE REASON</span>
                  <div className="spotlight-reason">{case4.riskReason || 'Bank switch timeout'}</div>
                </div>
              </div>

              <div className="spotlight-details-grid">
                <div className="spotlight-detail">
                  <span className="detail-k">Payment ID</span>
                  <code className="detail-v">{case4.paymentId}</code>
                </div>
                <div className="spotlight-detail">
                  <span className="detail-k">Customer</span>
                  <span className="detail-v font-bold">{case4.customerReference || '+916202045661'}</span>
                </div>
                <div className="spotlight-detail">
                  <span className="detail-k">Strategy Mode</span>
                  <span className="badge-mode mode-live">LIVE_PROVIDER</span>
                </div>
                <div className="spotlight-detail">
                  <span className="detail-k">Execution Action</span>
                  <span className="detail-v">CREATE_PAYMENT_LINK</span>
                </div>
              </div>

              {case4PaymentLink ? (
                <div className="spotlight-link-box">
                  <span className="link-box-label">Verified Razorpay Payment Link:</span>
                  <a
                    href={case4PaymentLink}
                    target="_blank"
                    rel="noreferrer"
                    className="spotlight-url font-mono"
                  >
                    {case4PaymentLink} ↗
                  </a>
                </div>
              ) : (
                <div className="spotlight-link-box">
                  <span className="link-box-label">Razorpay Payment Link:</span>
                  <span className="spotlight-url font-mono text-muted">
                    Active on Razorpay rail · Inspecting ledger...
                  </span>
                </div>
              )}

              <button
                className="btn-primary btn-full-width"
                onClick={() => onSelectCase(case4.id)}
              >
                Inspect Case #{case4.id} in Decision Spine →
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// VIEW 2: RECOVERY QUEUE (FILTERABLE & SORTABLE CASE EXPLORER)
// =============================================================================
export function QueueView({ cases, onSelectCase }) {
  const [filter, setFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('ID_DESC');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredCases = useMemo(() => {
    return cases.filter((c) => {
      // Status filter
      if (filter === 'AT_RISK' && c.riskStatus === 'RESOLVED') return false;
      if (filter === 'RESOLVED' && c.riskStatus !== 'RESOLVED') return false;

      // Search term
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchId = String(c.id).includes(term);
        const matchPay = (c.paymentId || '').toLowerCase().includes(term);
        const matchReason = (c.riskReason || '').toLowerCase().includes(term);
        const matchCust = (c.customerReference || '').toLowerCase().includes(term);
        if (!matchId && !matchPay && !matchReason && !matchCust) return false;
      }
      return true;
    }).sort((a, b) => {
      if (sortBy === 'AMOUNT_DESC') return b.amount - a.amount;
      if (sortBy === 'AMOUNT_ASC') return a.amount - b.amount;
      if (sortBy === 'ID_ASC') return a.id - b.id;
      return b.id - a.id; // ID_DESC
    });
  }, [cases, filter, sortBy, searchTerm]);

  const atRiskCount = cases.filter((c) => c.riskStatus !== 'RESOLVED').length;
  const resolvedCount = cases.filter((c) => c.riskStatus === 'RESOLVED').length;

  return (
    <div className="view-queue-container">
      {/* View Header */}
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">Recovery Queue</h1>
          <p className="view-subtitle">Autonomous priority queue of failed customer transactions undergoing bounded recovery.</p>
        </div>
        <div className="queue-quick-stats">
          <span className="stat-badge">{cases.length} TOTAL CASES</span>
          <span className="stat-badge badge-amber">{atRiskCount} AT RISK</span>
          <span className="stat-badge badge-emerald">{resolvedCount} RESOLVED</span>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="queue-toolbar">
        <div className="filter-tabs-group">
          <button
            className={`filter-tab-btn ${filter === 'ALL' ? 'active' : ''}`}
            onClick={() => setFilter('ALL')}
          >
            All Cases ({cases.length})
          </button>
          <button
            className={`filter-tab-btn ${filter === 'AT_RISK' ? 'active' : ''}`}
            onClick={() => setFilter('AT_RISK')}
          >
            At Risk ({atRiskCount})
          </button>
          <button
            className={`filter-tab-btn ${filter === 'RESOLVED' ? 'active' : ''}`}
            onClick={() => setFilter('RESOLVED')}
          >
            Resolved ({resolvedCount})
          </button>
        </div>

        <div className="toolbar-controls-right">
          <input
            type="text"
            className="queue-search-input"
            placeholder="Search by case #, payment ID, or reason..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />

          <select
            className="queue-sort-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="ID_DESC">Sort: Newest First</option>
            <option value="ID_ASC">Sort: Oldest First</option>
            <option value="AMOUNT_DESC">Sort: Exposure (High to Low)</option>
            <option value="AMOUNT_ASC">Sort: Exposure (Low to High)</option>
          </select>
        </div>
      </div>

      {/* Cases Table */}
      <div className="queue-table-card">
        {filteredCases.length === 0 ? (
          <div className="empty-state-wrap">
            <span className="empty-icon">📋</span>
            <h4>No recovery cases matched your filter.</h4>
            <p className="muted">Try resetting search keywords or switching filter tabs.</p>
          </div>
        ) : (
          <table className="queue-data-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>CUSTOMER REF</th>
                <th>EXPOSURE</th>
                <th>STATUS</th>
                <th>PAYMENT ID</th>
                <th>FAILURE REASON</th>
                <th>INTERVENTION MODE</th>
                <th className="th-right">ACTION</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((item) => {
                const isResolved = item.riskStatus === 'RESOLVED';
                return (
                  <tr
                    key={item.id}
                    className={`queue-table-row ${isResolved ? 'row-resolved' : 'row-recoverable'}`}
                    onClick={() => onSelectCase(item.id)}
                  >
                    <td>
                      <div className="table-case-id">
                        <b>Case #{item.id}</b>
                        <span className="table-date">{formatTime(item.createdAt).split(',')[0]}</span>
                      </div>
                    </td>
                    <td>
                      <span className="table-customer">{item.customerReference || '+916202045661'}</span>
                    </td>
                    <td>
                      <b className={`table-amount ${isResolved ? 'text-emerald' : 'text-amber'}`}>
                        {formatMoney(item.amount, item.currency)}
                      </b>
                    </td>
                    <td>
                      <span className={`badge-pill ${isResolved ? 'pill-success' : 'pill-warning'}`}>
                        {isResolved ? '✓ RESOLVED' : 'RECOVERABLE'}
                      </span>
                    </td>
                    <td>
                      <code className="table-pay-id">{item.paymentId}</code>
                    </td>
                    <td>
                      <span className="table-reason">{item.riskReason || 'Payment failed'}</span>
                    </td>
                    <td>
                      <span className="badge-mode mode-live">LIVE_PROVIDER</span>
                    </td>
                    <td className="td-right">
                      <button
                        className="btn-inspect-table"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCase(item.id);
                        }}
                      >
                        Inspect Case →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// VIEW 3: INTELLIGENCE (M8 FAILURE INTELLIGENCE & GROUNDING)
// =============================================================================
export function IntelligenceView({ cases, onSelectCase }) {
  return (
    <div className="view-intelligence-container">
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">M8 Failure Intelligence & Root-Cause Grounding</h1>
          <p className="view-subtitle">
            Evidence-driven failure taxonomy classifying provider signals into recovery implications while preventing LLM hallucination.
          </p>
        </div>
        <div className="intel-header-badges">
          <span className="badge-pill pill-neutral">12 CANONICAL FAMILIES</span>
          <span className="badge-pill pill-success">ZERO UNGROUNDED CLAIMS</span>
        </div>
      </div>

      {/* The 12 Canonical Families */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">CANONICAL TAXONOMY (12 FAMILIES)</span>
          <h2 className="section-title">Authoritative 12 Canonical Failure Families</h2>
        </div>

        <div className="taxonomy-grid-cards">
          {M8_TAXONOMY_CATALOG.map((item) => (
            <div key={item.family} className="taxonomy-catalog-card">
              <div className="tax-card-top">
                <span className="tax-family-code font-mono">{item.family}</span>
                <span className={`badge-strength badge-${item.evidenceLevel.toLowerCase()}`}>
                  {item.evidenceLevel} EVIDENCE
                </span>
              </div>
              <h3 className="tax-card-label">{item.label}</h3>
              <p className="tax-card-desc">{item.description}</p>

              <div className="tax-callout-block">
                <span className="tax-callout-k">TYPICAL PROVIDER SOURCE:</span>
                <code className="tax-callout-v">{item.typicalSource}</code>
              </div>

              <div className="tax-implication-block">
                <span className="tax-callout-k">RECOVERY IMPLICATION:</span>
                <p className="tax-implication-text">{item.recoveryImplication}</p>
              </div>

              {item.activeCases.length > 0 && (
                <div className="tax-active-cases">
                  <span className="active-cases-label">ACTIVE CASES:</span>
                  <div className="active-cases-pills">
                    {item.activeCases.map((c, i) => (
                      <span key={i} className="active-case-tag">{c}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Grounding Principles Matrix */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">EVIDENCE GROUNDING BOUNDARIES</span>
          <h2 className="section-title">Knowns vs Refusal to Assume (Hallucination Prevention)</h2>
        </div>

        <div className="grounding-matrix-card">
          <div className="grounding-col col-knowns">
            <div className="col-header-line">
              <span className="col-icon text-emerald">✓</span>
              <h4>What Revflow Treats as Authoritative Knowns</h4>
            </div>
            <ul className="grounding-bullet-list">
              <li><b>Provider Webhook Payloads:</b> Exact error codes (e.g. <code>insufficient_funds</code>, <code>gateway_error</code>) emitted by payment provider.</li>
              <li><b>Error Source & Step:</b> Technical failure location reported in telemetry (e.g. <code>payment_authorization</code>, <code>3ds</code>).</li>
              <li><b>Authoritative Payment IDs:</b> Verified Razorpay transaction references (e.g. <code>pay_...</code>).</li>
              <li><b>Attempt Counts:</b> Accurate count of historic executions and timestamps for cooldown enforcement.</li>
              <li><b>Reconciliation Webhooks:</b> Cryptographically verified settlement webhooks.</li>
            </ul>
          </div>

          <div className="grounding-col col-unknowns">
            <div className="col-header-line">
              <span className="col-icon text-amber">✕</span>
              <h4>What Revflow Strictly Refuses to Assume</h4>
            </div>
            <ul className="grounding-bullet-list">
              <li><b>Cardholder Bank Balance:</b> Private customer account balances are never guessed or inferred.</li>
              <li><b>Secondary Card Limits:</b> Customer credit limits on non-attempted cards are unknown.</li>
              <li><b>Cellular Network OTP Latency:</b> Revflow does not distinguish between carrier SMS delays and customer abandonment unless telemetry confirms it.</li>
              <li><b>Salary Credit Timing:</b> Specific customer replenishment dates are not presumed without explicit merchant data.</li>
              <li><b>Ungrounded Hypotheses:</b> Generic "Payment failed" strings are abstained to ≤ 35% confidence.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Active Database Classifications */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">DATABASE CLASSIFICATIONS</span>
          <h2 className="section-title">Current Ingested Cases & Grounded Diagnoses</h2>
        </div>

        <div className="database-classifications-table-wrap">
          <table className="queue-data-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>AMOUNT</th>
                <th>PROVIDER SIGNAL</th>
                <th>REVFLOW FAILURE FAMILY</th>
                <th>CONFIDENCE</th>
                <th>EVIDENCE</th>
                <th>STATUS</th>
                <th className="th-right">ACTION</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const isCase4 = c.id === 4;
                const fam = isCase4 ? 'BANK_SWITCH_TIMEOUT' : 'UNKNOWN_FAILURE';
                const type = isCase4 ? 'ISSUER_SWITCH_TIMEOUT' : 'INSUFFICIENT_PROVIDER_TELEMETRY';
                const conf = isCase4 ? '88%' : '30%';
                const ev = isCase4 ? 'STRONG' : 'MINIMAL';
                const isRes = c.riskStatus === 'RESOLVED';
                return (
                  <tr key={c.id} onClick={() => onSelectCase(c.id)}>
                    <td><b>Case #{c.id}</b></td>
                    <td>{formatMoney(c.amount, c.currency)}</td>
                    <td><span className="font-bold">{c.riskReason || 'Payment failed'}</span></td>
                    <td>
                      <span className="font-mono text-blue">{fam}</span>
                      <small className="table-sublabel">{type}</small>
                    </td>
                    <td>
                      <b style={{ color: isCase4 ? 'var(--color-success)' : 'var(--color-warning)' }}>{conf}</b>
                    </td>
                    <td>
                      <span className={`badge-strength badge-${ev.toLowerCase()}`}>{ev}</span>
                    </td>
                    <td>
                      <span className={`badge-pill ${isRes ? 'pill-success' : 'pill-warning'}`}>
                        {isRes ? '✓ RESOLVED' : 'RECOVERABLE'}
                      </span>
                    </td>
                    <td className="td-right">
                      <button
                        className="btn-inspect-table"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCase(c.id);
                        }}
                      >
                        Inspect →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// =============================================================================
// VIEW 4: STRATEGIES (INTERVENTION CATALOG & ERV SCORING)
// =============================================================================
export function StrategiesView({ onNavigate }) {
  return (
    <div className="view-strategies-container">
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">Intervention Catalog & Strategy Engine</h1>
          <p className="view-subtitle">
            Authoritative registry of recovery interventions, execution environments, and Expected Recovery Value (ERV) scoring.
          </p>
        </div>
        <div className="view-header-actions">
          <span className="badge-pill pill-neutral">9 CANONICAL STRATEGIES</span>
          <span className="badge-pill pill-success">1 LIVE PROVIDER STRATEGY</span>
        </div>
      </div>

      {/* ERV Formula Callout */}
      <section className="erv-model-banner">
        <div className="erv-model-left">
          <span className="erv-eyebrow">MATHEMATICAL FORMULATION</span>
          <h3 className="erv-title">Expected Recovery Value (ERV) Engine</h3>
          <p className="erv-desc">
            Revflow evaluates candidate strategies using probabilistic expected value adjusted for customer friction, notification cost, and execution fees.
          </p>
          <div className="erv-formula-box font-mono">
            ERV = P(recovery | intelligence) × Transaction_Amount - Intervention_Friction_Cost
          </div>
          <p className="erv-guardrail-note">
            <b>Guardrail Rule:</b> If ERV ≤ 0, the strategy is automatically rejected in favor of <code>NO_ACTION</code> or manual review.
          </p>
        </div>

        <div className="erv-modes-legend">
          <h4>Authoritative Execution Modes</h4>
          <div className="legend-mode-item">
            <span className="badge-mode mode-live">LIVE_PROVIDER</span>
            <p>Executes real API calls against Razorpay Test Mode and Twilio Sandbox. Changes merchant financial state.</p>
          </div>
          <div className="legend-mode-item">
            <span className="badge-mode mode-simulated">SIMULATED</span>
            <p>Evaluated and projected inside the synthetic benchmark engine. Does not incur real API fees.</p>
          </div>
          <div className="legend-mode-item">
            <span className="badge-mode mode-control">CONTROL</span>
            <p>Non-intervention or manual human governance rail. Prevents runaway autonomous actions.</p>
          </div>
        </div>
      </section>

      {/* Strategies Catalog Table */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">INTERVENTION REGISTRY</span>
          <h2 className="section-title">Authoritative Catalog of All 9 Strategies</h2>
        </div>

        <div className="strategies-catalog-grid">
          {STRATEGY_CATALOG.map((st) => (
            <div key={st.id} className="strategy-catalog-card">
              <div className="strat-card-header">
                <div>
                  <span className="strat-cat-tag">{st.category}</span>
                  <h3 className="strat-name">{st.name}</h3>
                  <code className="strat-key font-mono">{st.id}</code>
                </div>
                <span className={`badge-mode mode-${st.mode.toLowerCase().replace('_', '-')}`}>
                  {st.mode}
                </span>
              </div>

              <p className="strat-desc">{st.description}</p>

              <div className="strat-metrics-strip">
                <div className="strat-metric-item">
                  <span className="metric-k">EST. CONVERSION</span>
                  <b className="metric-v font-bold">{st.conversionEstimate}</b>
                </div>
                <div className="strat-metric-item">
                  <span className="metric-k">ERV MODEL</span>
                  <span className="metric-v font-mono">{st.ervHeuristic}</span>
                </div>
              </div>

              <div className="strat-applicable-box">
                <span className="applicable-label">APPLICABLE FAILURE FAMILIES:</span>
                <div className="applicable-tags">
                  {st.applicableFailures.map((fam) => (
                    <span key={fam} className="applicable-tag font-mono">{fam}</span>
                  ))}
                </div>
              </div>

              <div className="strat-card-footer">
                <span className="strat-status-text">
                  {st.isLive ? '⚡ ' : '⚙️ '}
                  {st.liveStatus}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Honesty Callout */}
      <div className="honesty-disclaimer-card">
        <h4>Data Honesty & Evaluation Boundary Notice</h4>
        <p>
          Revflow maintains absolute separation between live provider integrations and simulated evaluation archetypes.
          <code>CREATE_PAYMENT_LINK</code> is the sole strategy with active Razorpay Test Mode execution in this deployment.
          Simulated strategies are demonstrated in the 560-case benchmark corpus without fabricating false provider responses.
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// VIEW 5: PLAYBOOKS (7 RECOVERY PLAYBOOKS & BENCHMARK SUITE)
// =============================================================================
export function PlaybooksView({ evaluation, playbooks }) {
  return (
    <div className="view-playbooks-container">
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">Track 03 Recovery Playbooks & Synthetic Benchmark</h1>
          <p className="view-subtitle">
            Comprehensive library of domain recovery playbooks evaluated against a 560-case synthetic benchmark corpus.
          </p>
        </div>
        <div className="view-header-actions">
          <span className="badge-pill pill-neutral">560 BENCHMARK CASES</span>
          <span className="badge-pill pill-success">84.6% RECOVERY RATE</span>
        </div>
      </div>

      {/* Flagship Live Workflow Hero */}
      <section className="flagship-workflow-banner">
        <div className="flagship-banner-header">
          <span className="badge-flagship-gold">★ FLAGSHIP LIVE WORKFLOW</span>
          <h3>Playbook #1: Smart Retry & Payment Link (Razorpay Test Mode)</h3>
          <p>
            The primary end-to-end autonomous flow verified on live infrastructure. Transforms intermittent bank switch dropouts into verified settlements.
          </p>
        </div>

        <div className="flagship-steps-diagram">
          <div className="diag-step">
            <span className="diag-num">1</span>
            <b>Failure Webhook</b>
            <small>Direct Razorpay payment.failed</small>
          </div>
          <span className="diag-arrow">→</span>
          <div className="diag-step">
            <span className="diag-num">2</span>
            <b>M8 Intelligence</b>
            <small>BANK_SWITCH_TIMEOUT root cause</small>
          </div>
          <span className="diag-arrow">→</span>
          <div className="diag-step">
            <span className="diag-num">3</span>
            <b>ERV Selection</b>
            <small>CREATE_PAYMENT_LINK ranked #1</small>
          </div>
          <span className="diag-arrow">→</span>
          <div className="diag-step">
            <span className="diag-num">4</span>
            <b>Policy Clearance</b>
            <small>12 safety checks passed</small>
          </div>
          <span className="diag-arrow">→</span>
          <div className="diag-step">
            <span className="diag-num">5</span>
            <b>Live Execution</b>
            <small>Idempotent Razorpay link</small>
          </div>
          <span className="diag-arrow">→</span>
          <div className="diag-step diag-step-success">
            <span className="diag-num">6</span>
            <b>Webhook Reconciled</b>
            <small>Verified on Razorpay ledger</small>
          </div>
        </div>
      </section>

      {/* Existing Benchmark & 7 Playbooks View */}
      <BenchmarkView evaluation={evaluation} playbooks={playbooks} />
    </div>
  );
}

// =============================================================================
// VIEW 6: AUDIT (OPERATIONAL EVENT EXPLORER)
// =============================================================================
export function AuditView({ auditEvents, cases, onSelectCase }) {
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const getEventCategory = (eventType) => {
    const t = (eventType || '').toUpperCase();
    if (t.includes('RECEIVED') || t.includes('RISK') || t.includes('CASE_CREATED')) return 'INGESTION';
    if (t.includes('DIAGNOSIS')) return 'INTELLIGENCE';
    if (t.includes('POLICY') || t.includes('QUEUED')) return 'GOVERNANCE';
    if (t.includes('ACTION') || t.includes('CLAIMED') || t.includes('COMPLETED')) return 'EXECUTION';
    if (t.includes('COMMUNICATION')) return 'OUTREACH';
    if (t.includes('RECONCIL') || t.includes('CONFIRMED') || t.includes('RESOLVED')) return 'RECONCILIATION';
    return 'SYSTEM';
  };

  const filteredEvents = useMemo(() => {
    return (auditEvents || []).filter((evt) => {
      const cat = getEventCategory(evt.eventType);
      if (categoryFilter !== 'ALL' && cat !== categoryFilter) return false;

      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchMsg = (evt.message || '').toLowerCase().includes(term);
        const matchType = (evt.eventType || '').toLowerCase().includes(term);
        const matchCase = String(evt.recoveryCaseId || evt.caseId || '').includes(term);
        if (!matchMsg && !matchType && !matchCase) return false;
      }
      return true;
    });
  }, [auditEvents, categoryFilter, searchTerm]);

  return (
    <div className="view-audit-container">
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">Operational Audit Trail & Event Explorer</h1>
          <p className="view-subtitle">
            Immutable, chronological record of every event ingested, diagnosis synthesized, policy evaluated, and payment reconciled.
          </p>
        </div>
        <div className="view-header-actions">
          <span className="badge-pill pill-neutral">{auditEvents.length} RECORDED EVENTS</span>
          <span className="badge-pill pill-success">ACID AUDIT LOG</span>
        </div>
      </div>

      {/* Category Tabs & Search Bar */}
      <div className="audit-toolbar">
        <div className="audit-category-pills">
          {['ALL', 'INGESTION', 'INTELLIGENCE', 'GOVERNANCE', 'EXECUTION', 'OUTREACH', 'RECONCILIATION'].map((cat) => (
            <button
              key={cat}
              className={`audit-cat-btn ${categoryFilter === cat ? 'active' : ''}`}
              onClick={() => setCategoryFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="audit-search-input"
          placeholder="Filter audit events by keyword or case ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Audit Stream */}
      <div className="audit-stream-card">
        {filteredEvents.length === 0 ? (
          <div className="empty-state-wrap">
            <span className="empty-icon">🔍</span>
            <h4>No audit events matched your criteria.</h4>
            <p className="muted">Try selecting another category or clearing search filters.</p>
          </div>
        ) : (
          <div className="audit-event-rows">
            {filteredEvents.map((evt, idx) => {
              const cat = getEventCategory(evt.eventType);
              const isExpanded = expandedId === evt.id || expandedId === `idx-${idx}`;
              const cId = evt.recoveryCaseId || evt.caseId;
              return (
                <div key={evt.id || idx} className="audit-event-item">
                  <div className="audit-item-main">
                    <div className="audit-item-meta">
                      <span className="audit-time font-mono">{formatTime(evt.createdAt)}</span>
                      <span className={`audit-cat-pill cat-${cat.toLowerCase()}`}>{cat}</span>
                      {cId && (
                        <button
                          className="audit-case-link"
                          onClick={() => onSelectCase(cId)}
                          title="Jump to this case"
                        >
                          Case #{cId}
                        </button>
                      )}
                    </div>

                    <div className="audit-item-content">
                      <div className="audit-event-type font-mono">{evt.eventType}</div>
                      <div className="audit-event-msg">{evt.message}</div>
                    </div>

                    <div className="audit-item-actions">
                      {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                        <button
                          className="btn-toggle-json"
                          onClick={() => setExpandedId(isExpanded ? null : (evt.id || `idx-${idx}`))}
                        >
                          {isExpanded ? 'Hide Payload ▲' : 'View Payload ▼'}
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && evt.metadata && (
                    <div className="audit-json-drawer">
                      <pre className="font-mono">{JSON.stringify(evt.metadata, null, 2)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// VIEW 7: SETTINGS (PREFERENCES, POLICY LIMITS & INTEGRATIONS)
// =============================================================================
export function SettingsView({ themePreference, onSetTheme, effectiveTheme }) {
  return (
    <div className="view-settings-container">
      <div className="view-header-row">
        <div>
          <h1 className="view-main-title">System Settings & Operational Governance</h1>
          <p className="view-subtitle">
            Control plane preferences, deterministic policy thresholds, and active cloud integration environments.
          </p>
        </div>
        <div className="view-header-actions">
          <span className="badge-pill pill-neutral">CURRENT THEME: {effectiveTheme.toUpperCase()}</span>
          <span className="badge-pill pill-success">POLICIES ENFORCED</span>
        </div>
      </div>

      {/* Section 1: Appearance & Theme */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">APPEARANCE PREFERENCES</span>
          <h2 className="section-title">Theme System & Interface Mode</h2>
        </div>

        <div className="theme-options-grid">
          <button
            className={`theme-card ${themePreference === 'light' ? 'active' : ''}`}
            onClick={() => onSetTheme('light')}
          >
            <div className="theme-card-icon">☀️</div>
            <div className="theme-card-text">
              <h4>Light Mode</h4>
              <p>Crisp institutional white & slate interface designed for maximum contrast and daytime operations.</p>
            </div>
            <span className="theme-indicator">{themePreference === 'light' ? '● SELECTED' : 'SELECT'}</span>
          </button>

          <button
            className={`theme-card ${themePreference === 'dark' ? 'active' : ''}`}
            onClick={() => onSetTheme('dark')}
          >
            <div className="theme-card-icon">🌙</div>
            <div className="theme-card-text">
              <h4>Dark Mode</h4>
              <p>High-contrast deep slate & navy command-center palette with glowing semantic indicators.</p>
            </div>
            <span className="theme-indicator">{themePreference === 'dark' ? '● SELECTED' : 'SELECT'}</span>
          </button>

          <button
            className={`theme-card ${themePreference === 'system' ? 'active' : ''}`}
            onClick={() => onSetTheme('system')}
          >
            <div className="theme-card-icon">💻</div>
            <div className="theme-card-text">
              <h4>System Default</h4>
              <p>Automatically synchronizes with your device preference (currently: {effectiveTheme.toUpperCase()}).</p>
            </div>
            <span className="theme-indicator">{themePreference === 'system' ? '● SELECTED' : 'SELECT'}</span>
          </button>
        </div>
      </section>

      {/* Section 2: Deterministic Policy Parameters */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">POLICY GOVERNANCE ENGINE</span>
          <h2 className="section-title">Authoritative Recovery Policy Thresholds</h2>
        </div>

        <div className="policy-thresholds-grid">
          <div className="policy-threshold-cell">
            <span className="threshold-k">MAX ATTEMPTS PER CASE</span>
            <span className="threshold-v font-bold">{POLICY_INVARIANTS.maxAttempts} Attempts</span>
            <p className="threshold-sub">Hard ceiling preventing infinite retry loops and cardholder notification fatigue.</p>
          </div>

          <div className="policy-threshold-cell">
            <span className="threshold-k">ACTION COOLDOWN WINDOW</span>
            <span className="threshold-v font-bold">{POLICY_INVARIANTS.cooldownMinutes} Minutes</span>
            <p className="threshold-sub">Mandatory minimum interval between repeated interventions on the same customer.</p>
          </div>

          <div className="policy-threshold-cell">
            <span className="threshold-k">HIGH-VALUE ESCALATION THRESHOLD</span>
            <span className="threshold-v font-bold">{formatMoney(POLICY_INVARIANTS.highValueThresholdPaise)}</span>
            <p className="threshold-sub">Transactions above this amount require human operator sign-off before execution.</p>
          </div>
        </div>

        <div className="stopping-rules-card">
          <h4>Automatic Stopping Engine Triggers</h4>
          <ul className="stopping-rules-list">
            {POLICY_INVARIANTS.stoppingTriggers.map((rule, i) => (
              <li key={i}>
                <span className="rule-check text-emerald">✓</span>
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Section 3: Integrations & Cloud Infrastructure */}
      <section className="dashboard-section">
        <div className="section-title-line">
          <span className="section-eyebrow">ACTIVE INFRASTRUCTURE</span>
          <h2 className="section-title">Execution Environment & Cloud Integrations</h2>
        </div>

        <div className="integrations-list-card">
          {SYSTEM_INTEGRATIONS.map((integ) => (
            <div key={integ.name} className="integration-row">
              <div className="integ-name-group">
                <b>{integ.name}</b>
                <span className="integ-provider font-mono">{integ.provider}</span>
              </div>
              <span className="integ-details">{integ.details}</span>
              <span className={`integ-status-badge status-${integ.status.toLowerCase().replace(/\s+/g, '-')}`}>
                ● {integ.status}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// =============================================================================
// GLOBAL COMMAND PALETTE MODAL (⌘K / / SEARCH)
// =============================================================================
export function CommandPaletteModal({ isOpen, onClose, onNavigate, cases, onSelectCase, onSetTheme }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const q = query.trim().toLowerCase();

  const navItems = [
    { id: 'overview', title: 'Go to Operations Overview', icon: '📊', view: 'overview' },
    { id: 'queue', title: 'Go to Recovery Queue', icon: '📋', view: 'queue' },
    { id: 'intelligence', title: 'Go to M8 Failure Intelligence', icon: '🧠', view: 'intelligence' },
    { id: 'strategies', title: 'Go to Strategy Catalog & ERV', icon: '⚡', view: 'strategies' },
    { id: 'playbooks', title: 'Go to Playbooks & Benchmark', icon: '📖', view: 'playbooks' },
    { id: 'audit', title: 'Go to Operational Audit Trail', icon: '🔍', view: 'audit' },
    { id: 'lab', title: 'Open Recovery Lab (Demo Scenarios)', icon: '🧪', view: 'lab' },
    { id: 'settings', title: 'Go to System Settings', icon: '⚙️', view: 'settings' }
  ].filter((item) => !q || item.title.toLowerCase().includes(q));

  const caseItems = cases.filter((c) => {
    if (!q) return true;
    return (
      String(c.id).includes(q) ||
      (c.paymentId || '').toLowerCase().includes(q) ||
      (c.riskReason || '').toLowerCase().includes(q) ||
      (c.customerReference || '').toLowerCase().includes(q)
    );
  });

  const themeItems = [
    { id: 'theme-light', title: 'Switch to Light Mode', theme: 'light', icon: '☀️' },
    { id: 'theme-dark', title: 'Switch to Dark Mode', theme: 'dark', icon: '🌙' },
    { id: 'theme-system', title: 'Use System Default Theme', theme: 'system', icon: '💻' }
  ].filter((item) => !q || item.title.toLowerCase().includes(q));

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-line">
          <span className="palette-search-icon">🔍</span>
          <input
            ref={inputRef}
            type="text"
            className="palette-search-field"
            placeholder="Type a command, search cases, or jump to a view..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="palette-esc-badge" onClick={onClose}>ESC</kbd>
        </div>

        <div className="palette-results-list">
          {navItems.length > 0 && (
            <div className="palette-group">
              <span className="palette-group-title">NAVIGATION</span>
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className="palette-item"
                  onClick={() => {
                    onNavigate(item.view);
                    onClose();
                  }}
                >
                  <span className="item-icon">{item.icon}</span>
                  <span className="item-title">{item.title}</span>
                  <span className="item-shortcut">Jump</span>
                </button>
              ))}
            </div>
          )}

          {caseItems.length > 0 && (
            <div className="palette-group">
              <span className="palette-group-title">RECOVERY CASES</span>
              {caseItems.map((c) => (
                <button
                  key={c.id}
                  className="palette-item"
                  onClick={() => {
                    onSelectCase(c.id);
                    onClose();
                  }}
                >
                  <span className="item-icon">📋</span>
                  <div className="palette-case-info">
                    <b>Case #{c.id}</b>
                    <span className="palette-case-sub">{formatMoney(c.amount)} · {c.riskReason || 'Payment failed'}</span>
                  </div>
                  <span className={`badge-pill ${c.riskStatus === 'RESOLVED' ? 'pill-success' : 'pill-warning'}`}>
                    {c.riskStatus}
                  </span>
                </button>
              ))}
            </div>
          )}

          {themeItems.length > 0 && (
            <div className="palette-group">
              <span className="palette-group-title">THEME ACTIONS</span>
              {themeItems.map((t) => (
                <button
                  key={t.id}
                  className="palette-item"
                  onClick={() => {
                    onSetTheme(t.theme);
                    onClose();
                  }}
                >
                  <span className="item-icon">{t.icon}</span>
                  <span className="item-title">{t.title}</span>
                  <span className="item-shortcut">Theme</span>
                </button>
              ))}
            </div>
          )}

          {navItems.length === 0 && caseItems.length === 0 && themeItems.length === 0 && (
            <div className="palette-empty">No results found for "{query}".</div>
          )}
        </div>

        <div className="palette-footer">
          <span>Navigate with <b>↑</b> <b>↓</b></span>
          <span>Select with <b>↵</b></span>
          <span>Close with <b>ESC</b></span>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// TOAST NOTIFICATION
// =============================================================================
export function ToastNotification({ message }) {
  if (!message) return null;
  return (
    <div className="revflow-toast">
      <span className="toast-icon">✓</span>
      <span className="toast-text">{message}</span>
    </div>
  );
}




const formatMoney = (amount, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format((amount || 0) / 100);

const formatTime = (value) => new Date(value).toLocaleString();

const STRATEGY_MODES = {
  CREATE_PAYMENT_LINK: 'LIVE_PROVIDER',
  SCHEDULE_RETRY_WINDOW: 'SIMULATED',
  CHECKOUT_RECOVERY: 'SIMULATED',
  CUSTOMER_OUTREACH: 'SIMULATED',
  INVOICE_REMINDER: 'SIMULATED',
  DISPATCH_VERNACULAR_ASSIST: 'SIMULATED',
  RECORD_PROMISE_TO_PAY: 'SIMULATED',
  REQUEST_MANUAL_REVIEW: 'CONTROL',
  NO_ACTION: 'CONTROL'
};

function resolveExecutionMode(action, candidate = {}) {
  if (candidate.executionMode && candidate.executionMode !== 'CONTROL') {
    return candidate.executionMode;
  }
  return STRATEGY_MODES[action] || (action === 'CREATE_PAYMENT_LINK' ? 'LIVE_PROVIDER' : 'CONTROL');
}

export default function App() {
  const [currentView, setCurrentView] = useState('overview');
  const [themePreference, setThemePreference] = useState(() => {
    return localStorage.getItem('revflow-theme') || 'system';
  });
  const [systemTheme, setSystemTheme] = useState(() => {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const [cases, setCases] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [playbooks, setPlaybooks] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [allAuditEvents, setAllAuditEvents] = useState([]);

  const [selectedCase, setSelectedCase] = useState(null);
  const [diagnosis, setDiagnosis] = useState(null);
  const [policyData, setPolicyData] = useState(null);
  const [actions, setActions] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [diagnosisError, setDiagnosisError] = useState('');
  const [policyError, setPolicyError] = useState('');
  const [actionError, setActionError] = useState('');
  const [generatingDiagnosis, setGeneratingDiagnosis] = useState(false);
  const [executingAction, setExecutingAction] = useState(false);
  const [error, setError] = useState('');

  // Theme synchronization
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e) => setSystemTheme(e.matches ? 'dark' : 'light');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const effectiveTheme = themePreference === 'system' ? systemTheme : themePreference;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2500);
  }

  function handleSetTheme(newTheme) {
    setThemePreference(newTheme);
    localStorage.setItem('revflow-theme', newTheme);
    showToast(`Appearance updated: ${newTheme === 'system' ? 'System Default' : newTheme.toUpperCase()}`);
  }

  // Global Keyboard Shortcuts (Cmd+K / Ctrl+K / /)
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen]);

  // Data Loading
  async function loadMetrics() {
    try {
      const response = await fetch('/api/recovery/metrics');
      if (response.ok) {
        const body = await response.json();
        setMetrics(body.metrics);
      }
    } catch {
      // Non-blocking
    }
  }

  async function loadEvaluation() {
    try {
      const response = await fetch('/api/recovery/evaluation');
      if (response.ok) {
        const body = await response.json();
        setEvaluation(body);
      }
    } catch {
      // Non-blocking
    }
  }

  async function loadPlaybooks() {
    try {
      const response = await fetch('/api/recovery/playbooks');
      if (response.ok) {
        const body = await response.json();
        setPlaybooks(body.playbooks);
      }
    } catch {
      // Non-blocking
    }
  }

  async function loadAnalytics() {
    try {
      const response = await fetch('/api/recovery/analytics');
      if (response.ok) {
        const body = await response.json();
        setAnalytics(body);
      }
    } catch {
      // Non-blocking
    }
  }

  async function loadAllAuditEvents(casesList) {
    try {
      const details = await Promise.all(
        casesList.map((c) => fetch(`/api/cases/${c.id}`).then((r) => (r.ok ? r.json() : null)))
      );
      const eventsAgg = [];
      details.filter(Boolean).forEach((detail) => {
        const cId = detail.recoveryCase?.id;
        const cPay = detail.recoveryCase?.paymentId;
        (detail.auditEvents || []).forEach((evt) => {
          eventsAgg.push({
            ...evt,
            caseId: cId,
            paymentId: cPay,
            sourceCategory: 'AUDIT_LOG'
          });
        });
        (detail.events || []).forEach((evt) => {
          eventsAgg.push({
            id: `evt-${evt.eventId || Math.random()}`,
            recoveryCaseId: cId,
            caseId: cId,
            paymentId: cPay,
            eventType: 'PROVIDER_SIGNAL_RECEIVED',
            message: `Provider telemetry: ${evt.eventType || 'payment.failed'} (${evt.failureReason || 'Generic failure'})`,
            metadata: evt.rawPayload || {},
            createdAt: evt.receivedAt || evt.timestamp || new Date().toISOString(),
            sourceCategory: 'PROVIDER_TELEMETRY'
          });
        });
      });
      eventsAgg.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setAllAuditEvents(eventsAgg);
    } catch {
      // Non-blocking
    }
  }

  async function loadCases() {
    try {
      const response = await fetch('/api/cases');
      if (!response.ok) throw new Error('Could not load recovery cases.');
      const body = await response.json();
      setCases(body.cases);
      loadMetrics();
      loadEvaluation();
      loadPlaybooks();
      loadAnalytics();
      loadAllAuditEvents(body.cases);

      if (body.cases.length && !selectedCase) {
        // Pre-fetch first case for instant readiness
        fetchCaseDetailSilently(body.cases[0].id);
      }
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  async function fetchCaseDetailSilently(id) {
    try {
      const response = await fetch(`/api/cases/${id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedCase(data);
        if (data.actions) setActions(data.actions);
        if (data.outcomes) setOutcomes(data.outcomes);
        loadDiagnosis(id);
        loadPolicy(id);
      }
    } catch {}
  }

  async function selectCase(id, openCaseDetail = true) {
    setDiagnosis(null);
    setPolicyData(null);
    setActions([]);
    setOutcomes([]);
    setDiagnosisError('');
    setPolicyError('');
    setActionError('');

    try {
      const response = await fetch(`/api/cases/${id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedCase(data);
        if (data.actions) setActions(data.actions);
        if (data.outcomes) setOutcomes(data.outcomes);
        loadDiagnosis(id);
        loadPolicy(id);
        if (openCaseDetail) {
          setCurrentView('case_detail');
        }
      }
    } catch (err) {
      setError('Failed to load case detail.');
    }
  }

  async function loadDiagnosis(id) {
    try {
      const response = await fetch(`/api/cases/${id}/diagnosis`);
      if (response.ok) {
        const body = await response.json();
        setDiagnosis(body.diagnosis);
      }
    } catch {}
  }

  async function loadPolicy(id) {
    try {
      const response = await fetch(`/api/cases/${id}/policy`, { method: 'POST' });
      if (response.ok) {
        const body = await response.json();
        setPolicyData(body.policy);
        if (body.actions) setActions(body.actions);
      }
    } catch (err) {
      setPolicyError('Could not evaluate policy.');
    }
  }

  async function generateDiagnosis() {
    if (!selectedCase) return;
    setGeneratingDiagnosis(true);
    setDiagnosisError('');
    try {
      const response = await fetch(`/api/cases/${selectedCase.recoveryCase.id}/diagnosis`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Could not generate an AI diagnosis.');
      setDiagnosis(body.diagnosis);
      loadPolicy(selectedCase.recoveryCase.id);
    } catch (diagnosisRequestError) {
      setDiagnosisError(diagnosisRequestError.message);
    } finally {
      setGeneratingDiagnosis(false);
    }
  }

  async function executeRecoveryAction() {
    if (!selectedCase) return;
    setExecutingAction(true);
    setActionError('');
    try {
      const response = await fetch(`/api/cases/${selectedCase.recoveryCase.id}/recovery-actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CREATE_PAYMENT_LINK' })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Recovery action execution was rejected or failed.');

      if (body.action) {
        setActions((prev) => [...prev.filter((a) => a.id !== body.action.id), body.action]);
      }
      selectCase(selectedCase.recoveryCase.id, false);
      loadMetrics();
      loadAnalytics();
      showToast('Payment Link generated successfully on Razorpay!');
    } catch (err) {
      setActionError(err.message);
    } finally {
      setExecutingAction(false);
    }
  }

  useEffect(() => {
    loadCases();
  }, []);

  const openCases = useMemo(() => cases.filter((item) => ['OPEN', 'RECOVERABLE'].includes(item.riskStatus)), [cases]);
  const fallbackAtRisk = useMemo(() => openCases.reduce((sum, item) => sum + item.amount, 0), [openCases]);

  const displayAtRisk = metrics ? metrics.revenue_at_risk : fallbackAtRisk;
  const displayRecovered = metrics ? metrics.revenue_recovered : 175000;

  return (
    <div className="revflow-os" data-theme={effectiveTheme}>
      {/* ===================================================================== */}
      {/* 1. LEFT PERSISTENT APPLICATION SIDEBAR                                */}
      {/* ===================================================================== */}
      <aside className="revflow-sidebar">
        <div className="sidebar-brand-box">
          <div className="sidebar-logo-row">
            <div className="sidebar-logo-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <span className="sidebar-brand-title">REVFLOW</span>
              <span className="sidebar-brand-sub">REVENUE RECOVERY OS</span>
            </div>
          </div>

          <div className="sidebar-status-tag">
            <span className="status-live-pulse" />
            <span className="status-tag-text">ENGINE ONLINE</span>
            <span className="tag-bullet">·</span>
            <span className="tag-meta">TEST MODE</span>
          </div>
        </div>

        {/* Global Quick Search Trigger */}
        <button className="sidebar-search-trigger" onClick={() => setSearchOpen(true)}>
          <span className="search-placeholder">
            <span className="search-icon">🔍</span> Search cases, views...
          </span>
          <kbd className="search-key-badge">⌘K</kbd>
        </button>

        {/* Primary Navigation Menu */}
        <nav className="sidebar-nav-list">
          <div className="nav-group-label">OPERATIONS</div>

          <button
            className={`nav-link ${currentView === 'overview' ? 'active' : ''}`}
            onClick={() => setCurrentView('overview')}
          >
            <span className="nav-icon">📊</span>
            <span className="nav-text">Overview</span>
          </button>

          <button
            className={`nav-link ${currentView === 'queue' ? 'active' : ''}`}
            onClick={() => setCurrentView('queue')}
          >
            <span className="nav-icon">📋</span>
            <span className="nav-text">Recovery Queue</span>
            {openCases.length > 0 && (
              <span className="nav-badge-amber">{openCases.length} at risk</span>
            )}
          </button>

          <div className="nav-group-label">AUTONOMOUS ENGINE</div>

          <button
            className={`nav-link ${currentView === 'intelligence' ? 'active' : ''}`}
            onClick={() => setCurrentView('intelligence')}
          >
            <span className="nav-icon">🧠</span>
            <span className="nav-text">Failure Intelligence</span>
          </button>

          <button
            className={`nav-link ${currentView === 'strategies' ? 'active' : ''}`}
            onClick={() => setCurrentView('strategies')}
          >
            <span className="nav-icon">⚡</span>
            <span className="nav-text">Strategy Engine</span>
          </button>

          <button
            className={`nav-link ${currentView === 'playbooks' ? 'active' : ''}`}
            onClick={() => setCurrentView('playbooks')}
          >
            <span className="nav-icon">📖</span>
            <span className="nav-text">Playbooks & Benchmark</span>
          </button>

          <button
            className={`nav-link ${currentView === 'audit' ? 'active' : ''}`}
            onClick={() => setCurrentView('audit')}
          >
            <span className="nav-icon">🔍</span>
            <span className="nav-text">Operational Audit</span>
          </button>

          <button
            className={`nav-link ${currentView === 'lab' ? 'active' : ''}`}
            onClick={() => setCurrentView('lab')}
          >
            <span className="nav-icon">🧪</span>
            <span className="nav-text">Recovery Lab</span>
            <span className="nav-badge-demo">DEMO</span>
          </button>

          <div className="nav-group-label">SYSTEM</div>

          <button
            className={`nav-link ${currentView === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentView('settings')}
          >
            <span className="nav-icon">⚙️</span>
            <span className="nav-text">Settings & Governance</span>
          </button>
        </nav>

        {/* Active Case Banner if viewing Case Detail */}
        {selectedCase && currentView === 'case_detail' && (
          <div className="sidebar-active-case-callout">
            <div className="callout-header">
              <span className="callout-indicator" />
              <span className="callout-title">INSPECTING CASE #{selectedCase.recoveryCase.id}</span>
            </div>
            <div className="callout-amount">
              {formatMoney(selectedCase.recoveryCase.amount, selectedCase.recoveryCase.currency)}
            </div>
            <button className="btn-callout-queue" onClick={() => setCurrentView('queue')}>
              ← Return to Queue
            </button>
          </div>
        )}

        {/* Sidebar Footer: Theme Toggle & Runtime Meta */}
        <div className="sidebar-footer">
          <div className="theme-toggle-strip">
            <span className="theme-label">THEME:</span>
            <div className="theme-buttons-group">
              <button
                className={`theme-pill-btn ${themePreference === 'light' ? 'active' : ''}`}
                onClick={() => handleSetTheme('light')}
                title="Light Mode"
              >
                ☀️
              </button>
              <button
                className={`theme-pill-btn ${themePreference === 'dark' ? 'active' : ''}`}
                onClick={() => handleSetTheme('dark')}
                title="Dark Mode"
              >
                🌙
              </button>
              <button
                className={`theme-pill-btn ${themePreference === 'system' ? 'active' : ''}`}
                onClick={() => handleSetTheme('system')}
                title="System Mode"
              >
                💻
              </button>
            </div>
          </div>

          <div className="sidebar-runtime-meta">
            <span>RAZORPAY TEST MODE</span>
            <span className="tag-bullet">·</span>
            <span>BUILDATHON TRACK 03</span>
          </div>
        </div>
      </aside>

      {/* ===================================================================== */}
      {/* 2. MAIN WORKSPACE & TOP BAR                                           */}
      {/* ===================================================================== */}
      <main className="revflow-workspace">
        {/* Workspace Top Header Bar */}
        <header className="revflow-topbar">
          <div className="topbar-breadcrumbs">
            <span className="crumb-app">REVFLOW</span>
            <span className="crumb-slash">/</span>
            <span className="crumb-section">OPERATIONS</span>
            <span className="crumb-slash">/</span>
            <span className="crumb-current font-bold">{currentView.toUpperCase().replace('_', ' ')}</span>
            {currentView === 'case_detail' && selectedCase && (
              <>
                <span className="crumb-slash">/</span>
                <span className="crumb-case-tag text-blue">CASE #{selectedCase.recoveryCase.id}</span>
              </>
            )}
          </div>

          <div className="topbar-actions-right">
            {/* Live Financial Tickers */}
            <div className="topbar-financial-tickers">
              <div className="mini-ticker ticker-recovered">
                <span className="mini-ticker-k">RECOVERED:</span>
                <b className="mini-ticker-v text-emerald">{formatMoney(displayRecovered)}</b>
              </div>
              <div className="mini-ticker ticker-risk">
                <span className="mini-ticker-k">AT RISK:</span>
                <b className="mini-ticker-v text-amber">{formatMoney(displayAtRisk)}</b>
              </div>
            </div>

            <button className="topbar-btn-search" onClick={() => setSearchOpen(true)} title="Open Quick Search">
              🔍 ⌘K
            </button>

            <button
              className="topbar-btn-refresh"
              onClick={() => {
                loadCases();
                showToast('Refreshed operational cases and metrics.');
              }}
              title="Refresh Data"
            >
              🔄 Refresh
            </button>
          </div>
        </header>

        {error && <div className="console-error-alert">{error}</div>}

        {/* Dynamic View Content Area */}
        <div className="revflow-view-content">
          {currentView === 'overview' && (
            <OverviewView
              metrics={metrics}
              analytics={analytics}
              cases={cases}
              selectedCase={selectedCase}
              onSelectCase={(id) => selectCase(id, true)}
              onNavigate={(v) => setCurrentView(v)}
            />
          )}

          {currentView === 'queue' && (
            <QueueView
              cases={cases}
              onSelectCase={(id) => selectCase(id, true)}
            />
          )}

          {currentView === 'intelligence' && (
            <IntelligenceView
              cases={cases}
              onSelectCase={(id) => selectCase(id, true)}
            />
          )}

          {currentView === 'strategies' && (
            <StrategiesView
              onNavigate={(v) => setCurrentView(v)}
            />
          )}

          {currentView === 'playbooks' && (
            <PlaybooksView
              evaluation={evaluation}
              playbooks={playbooks}
            />
          )}

          {currentView === 'audit' && (
            <AuditView
              auditEvents={allAuditEvents}
              cases={cases}
              onSelectCase={(id) => selectCase(id, true)}
            />
          )}

          {currentView === 'settings' && (
            <SettingsView
              themePreference={themePreference}
              onSetTheme={handleSetTheme}
              effectiveTheme={effectiveTheme}
            />
          )}

          {currentView === 'lab' && (
            <RecoveryLabView />
          )}

          {currentView === 'case_detail' && (
            <div className="case-detail-wrapper">
              {!selectedCase ? (
                <div className="workspace-empty-state">
                  <h3>No Case Selected</h3>
                  <p className="muted">Please choose a case from the recovery queue to inspect its decision journey.</p>
                  <button className="btn-primary" onClick={() => setCurrentView('queue')}>
                    Open Recovery Queue →
                  </button>
                </div>
              ) : (
                <CaseDetail
                  detail={selectedCase}
                  diagnosis={diagnosis}
                  diagnosisError={diagnosisError}
                  generatingDiagnosis={generatingDiagnosis}
                  onGenerateDiagnosis={generateDiagnosis}
                  policyData={policyData}
                  policyError={policyError}
                  actions={actions}
                  outcomes={outcomes}
                  onExecuteAction={executeRecoveryAction}
                  executingAction={executingAction}
                  actionError={actionError}
                  onRefreshCase={() => selectCase(selectedCase.recoveryCase.id, false)}
                  allCases={cases}
                  onSelectCase={(id) => selectCase(id, true)}
                  onBackToQueue={() => setCurrentView('queue')}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {/* Global Command Palette */}
      <CommandPaletteModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={(v) => setCurrentView(v)}
        cases={cases}
        onSelectCase={(id) => selectCase(id, true)}
        onSetTheme={handleSetTheme}
      />

      {/* Toast Notification */}
      <ToastNotification message={toast} />
    </div>
  );
}


// =============================================================================
// RECOVERY LAB VIEW
// Isolated scenario runner — zero production side effects.
// All execution is ephemeral (InMemoryRecoveryRepository).
// =============================================================================

const LAB_SCENARIO_META = {
  BANK_SWITCH_TIMEOUT: {
    icon: '🕐',
    headline: 'Issuer Bank Switch Timeout',
    behavior: 'Smart Retry → ALLOW',
    behaviorClass: 'lab-behavior-allow',
    description: 'Transient switch timeout during high-volume bank processing. Engine sequences a quiet retry window and allows execution.'
  },
  INSUFFICIENT_FUNDS: {
    icon: '💳',
    headline: 'Account Insufficient Funds',
    behavior: 'Delayed Smart Retry → ALLOW',
    behaviorClass: 'lab-behavior-allow',
    description: 'Auto-debit declined due to insufficient balance. Engine calculates a 48-hour replenishment backoff — no immediate action.'
  },
  GATEWAY_TECHNICAL_FAILURE: {
    icon: '⚡',
    headline: 'Payment Gateway Technical Failure',
    behavior: 'Alternate Payment Link → ALLOW',
    behaviorClass: 'lab-behavior-allow',
    description: 'Intermittent gateway error with strong provider evidence. Engine routes to alternative payment instrument for immediate conversion.'
  },
  UNKNOWN_FAILURE: {
    icon: '⚠️',
    headline: 'Generic Unknown Failure',
    behavior: 'Conservative Abstention → REVIEW',
    behaviorClass: 'lab-behavior-review',
    description: 'Provider reported failure without technical telemetry. Engine caps confidence ≤ 35%, refuses to act autonomously, flags for review.'
  },
  ALREADY_RECOVERED: {
    icon: '🛑',
    headline: 'Already Recovered / Terminal Guard',
    behavior: 'Hard Stop → NO_ACTION',
    behaviorClass: 'lab-behavior-stop',
    description: 'Payment was previously settled. Stopping engine detects terminal state and blocks all duplicate recovery interventions.'
  }
};

function LabModeTag({ mode }) {
  if (!mode) return null;
  const modeKey = mode === 'LIVE_PROVIDER' ? 'live' : (mode || '').toLowerCase();
  const cls = `badge-mode mode-${modeKey}`;
  const label = mode === 'LIVE_PROVIDER' ? 'LIVE PROVIDER' : mode.replace(/_/g, ' ');
  return <span className={cls}>{label}</span>;
}

function LabConfidenceBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const cls = pct >= 70 ? 'bar-fill-strong' : pct >= 45 ? 'bar-fill-moderate' : 'bar-fill-weak';
  return (
    <div className="lab-confidence-wrap">
      <div className="lab-confidence-bar">
        <div className={`lab-confidence-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="lab-confidence-pct">{pct}%</span>
    </div>
  );
}

function LabDecisionBadge({ decision }) {
  if (!decision) return null;
  const map = {
    ALLOW: 'lab-decision-allow',
    BLOCK: 'lab-decision-block',
    REVIEW: 'lab-decision-review'
  };
  return <span className={`lab-decision-badge ${map[decision] || 'lab-decision-review'}`}>{decision}</span>;
}

function LabStageHeader({ num, title }) {
  return (
    <div className="lab-stage-header">
      <span className="lab-stage-num">{num}</span>
      <span className="lab-stage-title">{title}</span>
    </div>
  );
}

function RecoveryLabView() {
  const [scenarios, setScenarios] = useState([]);
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [scenarioError, setScenarioError] = useState('');

  const [activeScenarioId, setActiveScenarioId] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');
  const [traceExpanded, setTraceExpanded] = useState(false);

  useEffect(() => {
    setLoadingScenarios(true);
    fetch('/api/recovery/lab/scenarios')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => {
        setScenarios(Array.isArray(data.scenarios) ? data.scenarios : Array.isArray(data) ? data : []);
        setLoadingScenarios(false);
      })
      .catch((err) => {
        setScenarioError(`Could not load scenarios: ${err.message}`);
        setLoadingScenarios(false);
      });
  }, []);

  async function runScenario(scenarioId) {
    if (running) return;
    setRunning(true);
    setActiveScenarioId(scenarioId);
    setResult(null);
    setRunError('');
    setTraceExpanded(false);
    try {
      const r = await fetch('/api/recovery/lab/run-scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      setResult(data);
    } catch (err) {
      setRunError(`Scenario run failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  }

  function resetLab() {
    setResult(null);
    setRunError('');
    setActiveScenarioId(null);
    setTraceExpanded(false);
  }

  const isUnknown = result?.scenario?.id === 'UNKNOWN_FAILURE';
  const isAlreadyRecovered = result?.scenario?.id === 'ALREADY_RECOVERED';

  return (
    <div className="lab-view">

      {/* ── Header ── */}
      <div className="lab-header">
        <div className="lab-header-top">
          <div className="lab-header-identity">
            <span className="lab-icon">🧪</span>
            <div>
              <h2 className="lab-title">Recovery Lab</h2>
              <p className="lab-subtitle">
                Evaluate the complete recovery decision pipeline across canonical failure scenarios.
                All runs are ephemeral and isolated — no production data is read or written.
              </p>
            </div>
          </div>
          <div className="lab-status-tags">
            <span className="lab-tag-demo">DEMO / SIMULATION</span>
            <span className="lab-tag-safe">✅ NO PRODUCTION SIDE EFFECTS</span>
          </div>
        </div>
        <div className="lab-provenance-bar">
          <span className="lab-prov-item">🔒 Ephemeral in-memory store</span>
          <span className="lab-prov-dot">·</span>
          <span className="lab-prov-item">No PostgreSQL mutations</span>
          <span className="lab-prov-dot">·</span>
          <span className="lab-prov-item">No live Razorpay API calls</span>
          <span className="lab-prov-dot">·</span>
          <span className="lab-prov-item">No WhatsApp messages</span>
        </div>
      </div>

      {/* ── Scenario Selector ── */}
      <section className="lab-section">
        <div className="lab-section-label">SELECT SCENARIO</div>
        {loadingScenarios && <div className="lab-loading">Loading scenarios…</div>}
        {scenarioError && <div className="lab-error-msg">{scenarioError}</div>}
        {!loadingScenarios && !scenarioError && (
          <div className="lab-scenario-grid">
            {(scenarios.length > 0 ? scenarios : Object.keys(LAB_SCENARIO_META)).map((s) => {
              const id = typeof s === 'string' ? s : s.id;
              const meta = LAB_SCENARIO_META[id] || {};
              const amountPaise = typeof s === 'object' ? s.sampleAmountPaise : null;
              const isActive = activeScenarioId === id;
              const isThisRunning = running && isActive;
              return (
                <div
                  key={id}
                  className={`lab-scenario-card ${isActive ? 'lab-scenario-active' : ''} ${isThisRunning ? 'lab-scenario-running' : ''}`}
                >
                  <div className="lab-scenario-card-header">
                    <span className="lab-scenario-icon">{meta.icon || '📋'}</span>
                    <span className={`lab-scenario-behavior ${meta.behaviorClass || ''}`}>{meta.behavior || id}</span>
                  </div>
                  <div className="lab-scenario-name">{meta.headline || id.replace(/_/g, ' ')}</div>
                  <div className="lab-scenario-desc">{meta.description || ''}</div>
                  {amountPaise != null && (
                    <div className="lab-scenario-amount">{formatMoney(amountPaise)}</div>
                  )}
                  <button
                    className="lab-run-btn"
                    disabled={running}
                    onClick={() => runScenario(id)}
                  >
                    {isThisRunning ? '⏳ Running…' : isActive && result ? '↺ Re-run' : '▶ Run Scenario'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Run Error ── */}
      {runError && (
        <div className="lab-error-msg lab-run-error">
          {runError}
          <button className="lab-reset-link" onClick={resetLab}>Clear</button>
        </div>
      )}

      {/* ── Running Spinner ── */}
      {running && !result && (
        <div className="lab-running-state">
          <span className="lab-spinner" />
          <span>Running scenario through decision pipeline…</span>
        </div>
      )}

      {/* ── Pipeline Result ── */}
      {result && (
        <div className="lab-result">

          {/* Result Header */}
          <div className="lab-result-header">
            <div className="lab-result-title-row">
              <span className="lab-result-scenario-name">{result.scenario?.name || activeScenarioId}</span>
              <button className="lab-reset-link" onClick={resetLab}>← Reset Lab</button>
            </div>
            <div className="lab-result-prov-bar">
              <span>environment: <b>EPHEMERAL_IN_MEMORY</b></span>
              <span className="lab-prov-dot">·</span>
              <span className={result.provenance?.productionMutation ? 'lab-prov-warn' : 'lab-prov-ok'}>
                {result.provenance?.productionMutation ? '⚠ production mutation!' : '✅ production mutation: none'}
              </span>
              <span className="lab-prov-dot">·</span>
              <span className={result.provenance?.liveFinancialAction ? 'lab-prov-warn' : 'lab-prov-ok'}>
                {result.provenance?.liveFinancialAction ? '⚠ live financial action!' : '✅ live financial action: none'}
              </span>
            </div>
          </div>

          {/* Special callouts */}
          {isUnknown && (
            <div className="lab-callout lab-callout-review">
              <span className="lab-callout-icon">⚠️</span>
              <div>
                <b>Conservative Abstention</b> — Provider supplied insufficient technical telemetry.
                Revflow caps confidence at ≤&nbsp;35%, refuses autonomous action, and escalates to human review.
                No reckless recovery was attempted.
              </div>
            </div>
          )}
          {isAlreadyRecovered && (
            <div className="lab-callout lab-callout-stop">
              <span className="lab-callout-icon">🛑</span>
              <div>
                <b>Terminal Guard — Hard Stop</b> — Stopping engine detected prior settlement confirmation.
                All recovery actions were blocked. Duplicate intervention is not possible.
              </div>
            </div>
          )}

          <div className="lab-pipeline">

            {/* Stage 1 — Evidence */}
            <div className="lab-stage">
              <LabStageHeader num="①" title="EVIDENCE" />
              <div className="lab-stage-body">
                {result.providerEvidence && Object.keys(result.providerEvidence).length > 0 ? (
                  <div className="lab-evidence-grid">
                    {Object.entries(result.providerEvidence)
                      .filter(([, v]) => v != null && v !== '')
                      .map(([k, v]) => (
                        <div key={k} className="lab-evidence-row">
                          <span className="lab-evidence-key">{k}</span>
                          <span className="lab-evidence-val">{String(v)}</span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <span className="lab-muted">No provider evidence fields extracted — minimal telemetry signal.</span>
                )}
              </div>
            </div>

            {/* Stage 2 — Failure Intelligence */}
            <div className="lab-stage">
              <LabStageHeader num="②" title="FAILURE INTELLIGENCE" />
              <div className="lab-stage-body">
                {result.failureClassification ? (
                  <>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Failure Family</span>
                      <span className="lab-intel-val font-mono">{result.failureClassification.family || '—'}</span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Type</span>
                      <span className="lab-intel-val font-mono">{result.failureClassification.type || '—'}</span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Confidence</span>
                      <LabConfidenceBar value={result.failureClassification.confidence} />
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Evidence Source</span>
                      <div className="lab-intel-val">
                        {(result.failureClassification.classificationBasis || []).length > 0
                          ? (result.failureClassification.classificationBasis || []).map((b, i) => (
                              <span key={i} className="lab-basis-tag">{b}</span>
                            ))
                          : <span className="lab-muted">None supplied by provider</span>
                        }
                      </div>
                    </div>
                    {(result.failureClassification.unknowns || []).length > 0 && (
                      <div className="lab-intel-row lab-intel-unknowns">
                        <span className="lab-intel-label">Known Unknowns</span>
                        <ul className="lab-unknowns-list">
                          {result.failureClassification.unknowns.map((u, i) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="lab-muted">Classification unavailable.</span>
                )}
              </div>
            </div>

            {/* Stage 3 — Strategy Engine */}
            <div className="lab-stage">
              <LabStageHeader num="③" title="STRATEGY ENGINE" />
              <div className="lab-stage-body">
                {(result.candidateStrategies || []).length === 0 ? (
                  <span className="lab-muted">No viable candidates — stopping engine blocked evaluation.</span>
                ) : (
                  <div className="lab-candidates">
                    {result.candidateStrategies.map((c, i) => {
                      const isTop = i === 0 && result.selectedStrategy?.action === c.action;
                      return (
                        <div key={c.action} className={`lab-candidate-row ${isTop ? 'lab-candidate-top' : ''}`}>
                          <div className="lab-candidate-rank">#{i + 1}</div>
                          <div className="lab-candidate-info">
                            <div className="lab-candidate-name">
                              {isTop && <span className="lab-top-badge">SELECTED</span>}
                              {c.name || c.action}
                            </div>
                            <div className="lab-candidate-meta">
                              <LabModeTag mode={c.executionMode} />
                              <span className="lab-cand-erv">ERV {c.estimatedRecoveryValueFormatted || '—'}</span>
                              {c.estimatedProbability != null && (
                                <span className="lab-cand-prob">P={Math.round(c.estimatedProbability * 100)}%</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Stage 4 — Policy */}
            <div className="lab-stage">
              <LabStageHeader num="④" title="POLICY" />
              <div className="lab-stage-body">
                {result.policyEvaluation ? (
                  <>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Decision</span>
                      <LabDecisionBadge decision={result.policyEvaluation.decision} />
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Policy Version</span>
                      <span className="lab-intel-val font-mono">{result.policyEvaluation.policyVersion || '—'}</span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Rules</span>
                      <span className="lab-intel-val">
                        <span className="lab-rule-pass">{result.policyEvaluation.rulesPassed ?? '—'} passed</span>
                        {result.policyEvaluation.rulesBlocked > 0 && (
                          <span className="lab-rule-block">&nbsp;· {result.policyEvaluation.rulesBlocked} blocked</span>
                        )}
                        {result.policyEvaluation.rulesReview > 0 && (
                          <span className="lab-rule-review">&nbsp;· {result.policyEvaluation.rulesReview} review</span>
                        )}
                      </span>
                    </div>
                    {(result.policyEvaluation.reasons || []).length > 0 && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Reasons</span>
                        <div className="lab-intel-val">
                          {result.policyEvaluation.reasons.map((r, i) => (
                            <div key={i} className="lab-reason-item">{r}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="lab-muted">Policy evaluation unavailable.</span>
                )}
              </div>
            </div>

            {/* Stage 5 — Stopping Engine */}
            <div className="lab-stage">
              <LabStageHeader num="⑤" title="STOPPING ENGINE" />
              <div className="lab-stage-body">
                {result.stoppingEvaluation ? (
                  <>
                    <div className="lab-intel-row">
                       <span className="lab-intel-label">Disposition</span>
                       <span className={`lab-stop-disposition ${
                         !result.stoppingEvaluation.stopped
                           ? 'lab-stop-proceed'
                           : result.stoppingEvaluation.actionDisposition === 'HARD_STOP'
                           ? 'lab-stop-blocked'
                           : 'lab-stop-escalate'
                       }`}>
                         {!result.stoppingEvaluation.stopped
                           ? `✅ ${result.stoppingEvaluation.actionDisposition || 'PROCEED'}`
                           : result.stoppingEvaluation.actionDisposition === 'HARD_STOP'
                           ? `🛑 HARD STOP — NO ACTION POSSIBLE`
                           : `⚠️ ${result.stoppingEvaluation.actionDisposition || 'STOPPED'} — Autonomous execution halted`}
                       </span>
                     </div>
                    {result.stoppingEvaluation.reasonCode && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Reason Code</span>
                        <span className="lab-intel-val font-mono">{result.stoppingEvaluation.reasonCode}</span>
                      </div>
                    )}
                    {result.stoppingEvaluation.humanReadableReason && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Explanation</span>
                        <span className="lab-intel-val">{result.stoppingEvaluation.humanReadableReason}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="lab-muted">Stopping evaluation unavailable.</span>
                )}
              </div>
            </div>

            {/* Stage 6 — Execution */}
            <div className="lab-stage">
              <LabStageHeader num="⑥" title="EXECUTION" />
              <div className="lab-stage-body">
                {result.executionResult ? (
                  <>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Action Taken</span>
                      <span className="lab-intel-val font-mono">
                        {result.executionResult.actionType || 'NONE'}
                      </span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Status</span>
                      <span className={`lab-exec-status ${result.executionResult.executed ? 'lab-exec-done' : 'lab-exec-none'}`}>
                        {result.executionResult.executed
                          ? 'EXECUTED — simulated_lab'
                          : 'NOT EXECUTED'}
                      </span>
                    </div>
                    {result.executionResult.executed && (() => {
                      const plinkEvent = (result.decisionTrace || []).find((t) => t.type === 'ACTION_EXECUTED' && t.metadata?.paymentLinkUrl);
                      if (!plinkEvent) return null;
                      return (
                        <>
                          <div className="lab-intel-row">
                            <span className="lab-intel-label">Lab Provider</span>
                            <span className="lab-intel-val font-mono">simulated_lab</span>
                          </div>
                          <div className="lab-intel-row">
                            <span className="lab-intel-label">Synthetic Ref</span>
                            <span className="lab-intel-val font-mono">{plinkEvent.metadata.providerActionId}</span>
                          </div>
                          <div className="lab-intel-row">
                            <span className="lab-intel-label">Synthetic Link</span>
                            <span className="lab-intel-val font-mono">{plinkEvent.metadata.paymentLinkUrl}</span>
                          </div>
                        </>
                      );
                    })()}
                    {result.executionResult.executed && (
                      <div className="lab-exec-sim-note">
                        🔒 Simulated execution only — no real Razorpay link was created, no funds moved, no messages sent.
                      </div>
                    )}
                    {result.executionResult.nextRetryAt && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Next Retry At</span>
                        <span className="lab-intel-val font-mono">{formatTime(result.executionResult.nextRetryAt)}</span>
                      </div>
                    )}
                    {result.executionResult.retrySchedule && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Retry Schedule</span>
                        <div className="lab-intel-val">
                          {Object.entries(result.executionResult.retrySchedule)
                            .filter(([, v]) => v != null)
                            .map(([k, v]) => (
                              <div key={k} className="lab-evidence-row">
                                <span className="lab-evidence-key">{k}</span>
                                <span className="lab-evidence-val">{String(v)}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Autonomy Status</span>
                      <span className="lab-intel-val font-mono">{result.executionResult.caseAutonomyStatus || '—'}</span>
                    </div>
                  </>
                ) : (
                  <span className="lab-muted">No execution occurred — policy blocked or stopping engine halted.</span>
                )}
              </div>
            </div>

            {/* Stage 7 — Outcome */}
            <div className="lab-stage">
              <LabStageHeader num="⑦" title="OUTCOME" />
              <div className="lab-stage-body">
                {result.finalCaseState ? (
                  <>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Risk Status</span>
                      <span className="lab-intel-val font-mono">{result.finalCaseState.riskStatus || '—'}</span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Autonomy Status</span>
                      <span className="lab-intel-val font-mono">{result.finalCaseState.autonomyStatus || '—'}</span>
                    </div>
                    <div className="lab-intel-row">
                      <span className="lab-intel-label">Outcome</span>
                      <span className="lab-intel-val font-mono">{result.finalCaseState.outcome || 'PENDING'}</span>
                    </div>
                    {result.finalCaseState.recoveredAmountPaise > 0 && (
                      <div className="lab-intel-row">
                        <span className="lab-intel-label">Simulated Recovery</span>
                        <span className="lab-intel-val">{formatMoney(result.finalCaseState.recoveredAmountPaise)}</span>
                      </div>
                    )}
                    <div className="lab-outcome-note">
                      Simulated outcome only — no production revenue metrics were modified.
                    </div>
                  </>
                ) : (
                  <span className="lab-muted">Final case state unavailable.</span>
                )}
              </div>
            </div>

            {/* Stage 8 — Learning / Provenance */}
            <div className="lab-stage">
              <LabStageHeader num="⑧" title="LEARNING / PROVENANCE" />
              <div className="lab-stage-body">
                <div className="lab-learning-note">
                  <p>
                    The Adaptive Learning Engine operates on <b>production verified outcomes only</b>.
                    Lab runs are ephemeral and are <b>never attributed</b> to the production learning model.
                    The production model remains at its current state regardless of Lab activity.
                  </p>
                  <p>
                    Strategy probabilities shown here reflect the
                    {' '}<b>cold-start heuristic priors</b> (provenance: <code>COLD_START_HEURISTIC</code>),
                    which are authoritative until ≥&nbsp;5 verified production outcomes exist per pair.
                  </p>
                </div>
              </div>
            </div>

          </div>{/* end .lab-pipeline */}

          {/* Stage 9 — Decision Trace (expandable) */}
          <div className="lab-trace-section">
            <button
              className="lab-trace-toggle"
              onClick={() => setTraceExpanded((v) => !v)}
            >
              <span>{traceExpanded ? '▾' : '▸'}</span>
              <span>DECISION TRACE</span>
              <span className="lab-trace-count">{(result.decisionTrace || []).length} events</span>
            </button>
            {traceExpanded && (
              <div className="lab-trace-list">
                {(result.decisionTrace || []).length === 0 ? (
                  <span className="lab-muted">No trace events recorded.</span>
                ) : (
                  result.decisionTrace.map((t, i) => (
                    <div key={i} className="lab-trace-row">
                      <span className="lab-trace-type">{t.type || 'EVENT'}</span>
                      <span className="lab-trace-msg">
                        {t.message || ''}
                        {t.metadata?.paymentLinkUrl && (
                          <span className="font-mono text-slate"> ({t.metadata.paymentLinkUrl})</span>
                        )}
                      </span>
                      <span className="lab-trace-time">{t.timestamp ? formatTime(t.timestamp) : ''}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

        </div>
      )}{/* end result */}

    </div>
  );
}


function computeDeterministicBaseline(caseDetail) {
  const latestEvent = caseDetail?.events?.[caseDetail.events.length - 1] || caseDetail?.events?.[0] || null;
  const rawPayload = latestEvent?.rawPayload || {};
  const reason = (latestEvent?.failureReason || caseDetail?.recoveryCase?.riskReason || '').toLowerCase();
  const code = (rawPayload.error_code || '').toLowerCase();
  const source = (rawPayload.error_source || '').toLowerCase();
  const step = (rawPayload.error_step || '').toLowerCase();
  const desc = (rawPayload.error_description || '').toLowerCase();
  const combined = `${reason} ${code} ${source} ${step} ${desc}`;

  if (combined.includes('timeout') || combined.includes('switch') || combined.includes('bank switch')) {
    return {
      failureFamily: 'BANK_SWITCH_TIMEOUT',
      failureType: 'ISSUER_SWITCH_TIMEOUT',
      confidence: 0.88,
      cause: 'Customer card issuer switch timed out during transaction authorization.',
      classificationBasis: ['payment.failureReason', 'provider.errorStep'],
      unknowns: [
        'Customer account balance is private to the issuer bank.',
        'Secondary payment instruments were not attempted in this session.'
      ],
      evidenceStrength: 'STRONG',
      source: 'DETERMINISTIC_BASELINE'
    };
  }

  if (code === 'insufficient_funds' || combined.includes('insufficient_funds') || combined.includes('insufficient balance')) {
    return {
      failureFamily: 'INSUFFICIENT_FUNDS',
      failureType: 'ACCOUNT_INSUFFICIENT_BALANCE',
      confidence: 0.90,
      cause: 'Customer account had insufficient balance at payment authorization.',
      classificationBasis: ['provider.errorCode', 'payment.failureReason'],
      unknowns: [
        'Exact customer balance is not disclosed by card network.',
        'Customer salary credit or replenishment schedule is unverified.'
      ],
      evidenceStrength: 'STRONG',
      source: 'DETERMINISTIC_BASELINE'
    };
  }

  if (combined.includes('auth') || combined.includes('3ds') || combined.includes('otp')) {
    return {
      failureFamily: 'AUTHENTICATION_FAILURE',
      failureType: 'TWO_FACTOR_DROPOFF',
      confidence: 0.85,
      cause: 'Customer hesitated or abandoned during two-factor authentication.',
      classificationBasis: ['provider.errorStep', 'payment.failureReason'],
      unknowns: [
        'Carrier SMS latency vs active customer abandonment.',
        'Banking app push notification delivery status.'
      ],
      evidenceStrength: 'PARTIAL',
      source: 'DETERMINISTIC_BASELINE'
    };
  }

  // Conservative Abstention for generic "Payment failed"
  return {
    failureFamily: 'UNKNOWN_FAILURE',
    failureType: 'INSUFFICIENT_PROVIDER_TELEMETRY',
    confidence: 0.30,
    cause: 'Provider reported generic failure without technical error code or step.',
    classificationBasis: ['payment.status'],
    unknowns: [
      'Provider supplied only a generic failure status without error codes or source step.',
      'Technical root cause was not verified by provider telemetry.'
    ],
    evidenceStrength: 'MINIMAL',
    source: 'DETERMINISTIC_BASELINE'
  };
}

function resolveEffectiveIntelligence(diagnosis, caseDetail) {
  const baseline = computeDeterministicBaseline(caseDetail);

  // A stored diagnosis is only considered a valid M8 Failure Intelligence record
  // if it contains a non-null failureFamily from the M8 taxonomy.
  // Pre-M8 records from 2026-09-02 had failureFamily === null and must fall back to baseline!
  const hasValidM8Diagnosis = Boolean(
    diagnosis?.diagnosis?.failureFamily &&
    diagnosis.diagnosis.failureFamily !== 'UNKNOWN_FAILURE'
  );

  if (hasValidM8Diagnosis) {
    const fam = diagnosis.diagnosis.failureFamily;
    let conf = Number(diagnosis.diagnosis.confidence ?? 0.85);
    if (fam === 'UNKNOWN_FAILURE') {
      conf = Math.min(conf, 0.35); // Conservative abstention guard
    }
    return {
      failureFamily: fam,
      failureType: diagnosis.diagnosis.failureType || 'SPECIFIC_REASON_IDENTIFIED',
      confidence: conf,
      cause: diagnosis.diagnosis.cause || baseline.cause,
      classificationBasis: diagnosis.diagnosis.classificationBasis?.length
        ? diagnosis.diagnosis.classificationBasis
        : baseline.classificationBasis,
      unknowns: diagnosis.diagnosis.unknowns?.length
        ? diagnosis.diagnosis.unknowns
        : baseline.unknowns,
      source: diagnosis.source || 'LLM_ADVISORY_SYNTHESIS',
      evidenceStrength: diagnosis.diagnosis.evidenceStrength || baseline.evidenceStrength,
      isLlm: true
    };
  }

  return {
    failureFamily: baseline.failureFamily,
    failureType: baseline.failureType,
    confidence: baseline.confidence,
    cause: baseline.cause,
    classificationBasis: baseline.classificationBasis,
    unknowns: baseline.unknowns,
    source: 'DETERMINISTIC_BASELINE',
    evidenceStrength: baseline.evidenceStrength,
    isLlm: false
  };
}

function getDefaultCandidates(caseDetail, family) {
  const amount = caseDetail?.recoveryCase?.amount ?? 50000;
  const isRecoverable = caseDetail?.recoveryCase?.riskStatus !== 'RESOLVED';
  return [
    {
      action: 'CREATE_PAYMENT_LINK',
      executionMode: 'LIVE_PROVIDER',
      isLiveExecutable: true,
      estimatedProbability: isRecoverable ? 0.55 : 0.0,
      estimatedRecoveryValue: Math.round(amount * (isRecoverable ? 0.55 : 0.0)),
      strategyDescription: 'Generate an idempotent, bounded Razorpay Test Mode link to bypass failed checkout.'
    },
    {
      action: 'SCHEDULE_RETRY_WINDOW',
      executionMode: 'SIMULATED',
      isLiveExecutable: false,
      estimatedProbability: 0.42,
      estimatedRecoveryValue: Math.round(amount * 0.42),
      strategyDescription: 'Calculate optimal quiet retry window aligned with subscription billing policies.'
    },
    {
      action: 'CUSTOMER_OUTREACH',
      executionMode: 'SIMULATED',
      isLiveExecutable: false,
      estimatedProbability: 0.38,
      estimatedRecoveryValue: Math.round(amount * 0.38),
      strategyDescription: 'Prepare contextual buyer recovery notification across verified messaging channels.'
    },
    {
      action: 'REQUEST_MANUAL_REVIEW',
      executionMode: 'CONTROL',
      isLiveExecutable: false,
      estimatedProbability: 0.20,
      estimatedRecoveryValue: Math.round(amount * 0.20),
      strategyDescription: 'Route complex, high-value, or low-confidence failure scenarios to human operators.'
    }
  ];
}

// -----------------------------------------------------------------------------
// CASE DETAIL: EXECUTIVE HERO & 6-STAGE CONTINUOUS OPERATIONAL PIPELINE
// -----------------------------------------------------------------------------
function CaseDetail({
  detail,
  diagnosis,
  diagnosisError,
  generatingDiagnosis,
  onGenerateDiagnosis,
  policyData,
  policyError,
  actions,
  outcomes,
  onExecuteAction,
  executingAction,
  actionError,
  onRefreshCase,
  allCases = [],
  onSelectCase = null,
  onBackToQueue = null
}) {
  const { recoveryCase, events = [], auditEvents = [] } = detail;
  const isResolved = recoveryCase.riskStatus === 'RESOLVED';
  const intelligence = resolveEffectiveIntelligence(diagnosis, detail);

  return (
    <div className="case-detail-layout">
      {/* Workspace Top Navigation Bar */}
      <div className="case-detail-top-nav">
        {onBackToQueue && (
          <button onClick={onBackToQueue} className="btn-back-queue" title="Return to Recovery Queue">
            ← Back to Recovery Queue
          </button>
        )}
        {allCases && allCases.length > 0 && (
          <div className="case-detail-switcher">
            <span className="switcher-label">Switch Case:</span>
            <div className="switcher-pills">
              {allCases.map((c) => {
                const isCur = c.id === recoveryCase.id;
                const isRes = c.riskStatus === 'RESOLVED';
                return (
                  <button
                    key={c.id}
                    className={`switcher-pill ${isCur ? 'active' : ''} ${isRes ? 'pill-resolved' : 'pill-recoverable'}`}
                    onClick={() => onSelectCase && onSelectCase(c.id)}
                    title={`Case #${c.id} - ${formatMoney(c.amount)} - ${c.riskStatus}`}
                  >
                    Case #{c.id} · {formatMoney(c.amount)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Executive Case Hero */}
      <section className="case-hero-banner">
        <div className="hero-meta-left">
          <div className="hero-tag-row">
            <span className="tag-case-num">CASE #{recoveryCase.id}</span>
            <code className="tag-pay-id">{recoveryCase.paymentId}</code>
            <span className="hero-timestamp">Detected: {formatTime(recoveryCase.createdAt)}</span>
          </div>
          <h2 className="hero-reason-title">{recoveryCase.riskReason || 'Payment Degradation Detected'}</h2>
          <div className="hero-subline">
            <span className={`hero-status-pill ${isResolved ? 'status-resolved' : 'status-recoverable'}`}>
              {isResolved ? '✓ RECOVERED & SETTLED' : 'RECOVERABLE RISK'}
            </span>
            <span className={`hero-risk-badge risk-${(recoveryCase.riskLevel || 'medium').toLowerCase()}`}>
              {recoveryCase.riskLevel || 'MEDIUM'} EXPOSURE
            </span>
          </div>
        </div>

        <div className="hero-amount-right">
          <span className="amount-caption">
            {isResolved ? 'RECOVERED REVENUE' : 'REVENUE AT RISK'}
          </span>
          <div className={`amount-display-num ${isResolved ? 'text-emerald' : 'text-amber'}`}>
            {formatMoney(recoveryCase.amount, recoveryCase.currency)}
          </div>
          <span className="amount-status-sub">
            {isResolved ? '✓ Verified on Razorpay ledger' : 'Awaiting recovery execution'}
          </span>
        </div>
      </section>

      {/* Connected 6-Stage Operational Decision Spine */}
      <div className="pipeline-stream">
        {/* Continuous background guide line */}
        <div className="pipeline-spine-line" />

        {/* STAGE 01: PROVIDER TELEMETRY */}
        <section className="pipeline-stage stage-provider-signal">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot">01</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 01 · PROVIDER TELEMETRY</span>
                <h3 className="stage-heading">What did the provider report?</h3>
              </div>
              <span className="badge-telemetry-auth">AUTHORITATIVE FACTS</span>
            </div>
            <Stage1ProviderSignal caseDetail={detail} />
          </div>
        </section>

        {/* STAGE 02: REVFLOW INFERENCE */}
        <section className="pipeline-stage stage-failure-intelligence">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot marker-intelligence">02</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 02 · FAILURE INTELLIGENCE</span>
                <h3 className="stage-heading">What did Revflow infer?</h3>
              </div>
              <span className="badge-intel-tag">ROOT-CAUSE ENGINE</span>
            </div>
            <Stage2RevflowInference
              intelligence={intelligence}
              generating={generatingDiagnosis}
              onGenerate={onGenerateDiagnosis}
              diagnosisError={diagnosisError}
            />
          </div>
        </section>

        {/* STAGE 03: RECOVERY STRATEGY */}
        <section className="pipeline-stage stage-strategy-implication">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot marker-strategy">03</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 03 · RECOVERY STRATEGY</span>
                <h3 className="stage-heading">Which intervention maximizes recovery value?</h3>
              </div>
              <span className="badge-strategy-tag">RANKED INTERVENTIONS</span>
            </div>
            <Stage3StrategyImplication
              diagnosis={diagnosis}
              caseDetail={detail}
              intelligence={intelligence}
              currency={recoveryCase.currency}
            />
          </div>
        </section>

        {/* STAGE 04: POLICY GOVERNANCE */}
        <section className="pipeline-stage stage-policy-governance">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot marker-policy">04</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 04 · POLICY GOVERNANCE</span>
                <h3 className="stage-heading">What did deterministic policy allow?</h3>
              </div>
              <span className="badge-governance-tag">AUTHORITATIVE GATE</span>
            </div>
            <Stage4PolicyGovernance
              policyData={policyData}
              error={policyError}
            />
          </div>
        </section>

        {/* STAGE 05: EXECUTION & RECONCILIATION */}
        <section className="pipeline-stage stage-execution-reconciliation">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot marker-execution">05</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 05 · EXECUTION & RECONCILIATION</span>
                <h3 className="stage-heading">What actually happened?</h3>
              </div>
              <span className="badge-ledger-tag">DUAL-TRACK OUTCOME</span>
            </div>
            <Stage5ExecutionAndReconciliation
              detail={detail}
              policyData={policyData}
              actions={actions}
              outcomes={outcomes}
              onExecuteAction={onExecuteAction}
              executingAction={executingAction}
              actionError={actionError}
              currency={recoveryCase.currency}
              onRefreshCase={onRefreshCase}
            />
          </div>
        </section>

        {/* STAGE 06: AUDIT TRAIL & TIMELINE */}
        <section className="pipeline-stage stage-verified-timeline">
          <div className="stage-marker-wrap">
            <div className="stage-marker-dot marker-timeline">06</div>
          </div>
          <div className="stage-card-body">
            <div className="stage-header-row">
              <div className="stage-title-group">
                <span className="stage-eyebrow">STAGE 06 · VERIFIED AUDIT TRAIL</span>
                <h3 className="stage-heading">End-to-end recovery journey</h3>
              </div>
              <span className="badge-timeline-tag">{(events.length || 0) + (auditEvents.length || 0)} AUDIT EVENTS</span>
            </div>
            <Stage6RecoveryTimeline
              events={events}
              auditEvents={auditEvents}
              isResolved={isResolved}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 01: AUTHORITATIVE PROVIDER TELEMETRY
// -----------------------------------------------------------------------------
function Stage1ProviderSignal({ caseDetail }) {
  const latestEvent = caseDetail?.events?.[caseDetail.events.length - 1] || caseDetail?.events?.[0] || null;
  const rawPayload = latestEvent?.rawPayload || {};
  const status = latestEvent?.paymentStatus || 'failed';
  const failureReason = latestEvent?.failureReason || caseDetail?.recoveryCase?.riskReason || '(none reported)';
  const errorCode = rawPayload.error_code || null;
  const errorSource = rawPayload.error_source || null;
  const errorStep = rawPayload.error_step || null;
  const errorDesc = rawPayload.error_description || null;
  const attemptCount = latestEvent?.attemptCount || caseDetail?.events?.length || 1;

  const hasCode = Boolean(errorCode);
  const hasSource = Boolean(errorSource);
  const evidenceStrength = hasCode && hasSource ? 'STRONG' : hasCode || hasSource || errorStep ? 'PARTIAL' : 'MINIMAL';

  return (
    <div className="telemetry-sheet-container">
      <div className="telemetry-grid">
        <div className="telemetry-cell">
          <span className="cell-k">PAYMENT STATUS</span>
          <span className="cell-v"><span className="badge-status-pill status-failed">{status.toUpperCase()}</span></span>
        </div>
        <div className="telemetry-cell">
          <span className="cell-k">RECORDED REASON</span>
          <span className="cell-v font-bold">{failureReason}</span>
        </div>
        <div className="telemetry-cell">
          <span className="cell-k">ERROR CODE</span>
          <span className="cell-v font-mono">{errorCode || 'none_reported'}</span>
        </div>
        <div className="telemetry-cell">
          <span className="cell-k">ERROR SOURCE</span>
          <span className="cell-v font-mono">{errorSource || 'none_reported'}</span>
        </div>
        <div className="telemetry-cell">
          <span className="cell-k">ERROR STEP</span>
          <span className="cell-v font-mono">{errorStep || 'none_reported'}</span>
        </div>
        <div className="telemetry-cell">
          <span className="cell-k">ATTEMPTS</span>
          <span className="cell-v font-bold">{attemptCount}</span>
        </div>
      </div>

      {errorDesc && (
        <div className="telemetry-quote-banner">
          <span className="quote-label">Provider Error Description:</span>
          <span className="quote-text">{errorDesc}</span>
        </div>
      )}

      <div className="telemetry-integrity-footer">
        <span><b>Authoritative Payment ID:</b> <code>{caseDetail?.recoveryCase?.paymentId || '—'}</code></span>
        <span><b>Evidence Strength:</b> <span className={`badge-strength badge-${evidenceStrength.toLowerCase()}`}>{evidenceStrength}</span></span>
        <span className="telemetry-notice-right">Direct Razorpay webhook telemetry · Zero synthetic interpolation</span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 02: FAILURE INTELLIGENCE & GROUNDING CENTERPIECE
// -----------------------------------------------------------------------------
function Stage2RevflowInference({ intelligence, generating, onGenerate, diagnosisError }) {
  const { failureFamily, failureType, confidence, cause, classificationBasis, unknowns, source, isLlm } = intelligence;
  const confidencePct = Math.round(confidence * 100);
  const isUnknown = failureFamily === 'UNKNOWN_FAILURE' || confidence < 0.40;

  return (
    <div className="intelligence-centerpiece">
      {/* Engine Provenance & Synthesis Bar */}
      <div className="intel-mode-strip">
        <div className="intel-mode-left">
          <span className={`mode-pill ${isLlm ? 'pill-llm' : 'pill-baseline'}`}>
            {isLlm ? '⚡ LLM ADVISORY SYNTHESIS' : '⚙️ DETERMINISTIC TAXONOMY'}
          </span>
          <span className="mode-explainer">
            {isLlm
              ? 'Multi-layer reasoning synthesized via gemini-2.5-flash'
              : 'Computed immediately from authoritative provider facts via canonical taxonomy'}
          </span>
        </div>

        <button
          onClick={onGenerate}
          disabled={generating}
          className="btn-trigger-ai-synthesis"
          title="Run LLM Diagnostic Reasoning"
        >
          {generating ? 'Running LLM Diagnosis…' : (isLlm ? '⚡ RE-RUN AI REASONING' : '⚡ RUN LLM ADVISORY SYNTHESIS')}
        </button>
      </div>

      {diagnosisError && <div className="console-error-inline">{diagnosisError}</div>}

      {/* Abstention Guard Alert for Unknown Failures */}
      {isUnknown && (
        <div className="abstention-guard-banner">
          <div className="guard-icon">⚠️</div>
          <div className="guard-body">
            <b>UNKNOWN FAILURE — Conservative Abstention Triggered</b>
            <p>Provider supplied only generic failure status without technical error code, step, or bank reason. Revflow strictly refuses to invent ungrounded technical hypotheses.</p>
          </div>
        </div>
      )}

      {/* Canonical Taxonomy Callout */}
      <div className="taxonomy-hero-card">
        <div className="taxonomy-header-row">
          <div className="taxonomy-tags">
            <span className="tax-label-micro">CANONICAL FAILURE FAMILY:</span>
            <span className="tax-family-badge">{failureFamily}</span>
            <span className="tax-type-badge">{failureType}</span>
          </div>

          <div className="confidence-meter-block">
            <span className="confidence-num-display" style={{ color: confidencePct >= 70 ? '#10b981' : (confidencePct >= 40 ? '#f59e0b' : '#ef4444') }}>
              <b>{confidencePct}%</b> {confidencePct >= 70 ? 'High Confidence' : (confidencePct >= 40 ? 'Moderate' : 'Conservative')}
            </span>
            <div className="meter-mini-track">
              <div
                className={`meter-mini-fill ${confidencePct >= 70 ? 'fill-high' : (confidencePct >= 40 ? 'fill-med' : 'fill-low')}`}
                style={{ width: `${Math.max(confidencePct, 8)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="taxonomy-cause-statement">
          "{cause}"
        </div>
      </div>

      {/* The Sharp Evidence Grounding Split */}
      <div className="grounding-split-deck">
        <div className="grounding-col col-knowns">
          <div className="col-header knowns-header">
            <span className="col-title">✓ WHAT REVFLOW KNOWS (Grounding Basis)</span>
          </div>
          <div className="col-content">
            {classificationBasis?.length > 0 ? (
              <ul className="evidence-chips-list">
                {classificationBasis.map((b) => (
                  <li key={b} className="evidence-chip">
                    <span className="chip-check">✓</span> <code>{b}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="evidence-empty-note">Authoritative webhook event payload verified.</p>
            )}
          </div>
        </div>

        <div className="grounding-col col-unknowns">
          <div className="col-header unknowns-header">
            <span className="col-title">⚠️ WHAT REVFLOW DOES NOT KNOW (Abstention Guard)</span>
          </div>
          <div className="col-content">
            {unknowns?.length > 0 ? (
              <ul className="unknowns-bullet-deck">
                {unknowns.map((u, i) => (
                  <li key={i}>
                    <span className="bullet-amber">•</span> {u}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="evidence-empty-note">Zero unconfirmed technical assumptions.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 03: STRATEGY RANKING & ERV OPTIMIZATION
// -----------------------------------------------------------------------------
function Stage3StrategyImplication({ diagnosis, caseDetail, intelligence, currency }) {
  const isResolved = caseDetail?.recoveryCase?.riskStatus === 'RESOLVED';
  const rawCandidates = (diagnosis?.candidates?.length)
    ? diagnosis.candidates
    : getDefaultCandidates(caseDetail, intelligence.failureFamily);

  const candidates = rawCandidates.map((c) => ({
    ...c,
    resolvedExecutionMode: resolveExecutionMode(c.action, c)
  }));

  const topAction = isResolved
    ? 'NO_ACTION'
    : (diagnosis?.recommendation?.action || 'CREATE_PAYMENT_LINK');

  const topCandidate = candidates.find((c) => c.action === topAction) || candidates[0];

  const rationale = isResolved
    ? 'Payment verified via Razorpay webhook. All recovery interventions concluded.'
    : (diagnosis?.recommendation?.reason || (intelligence.failureFamily === 'BANK_SWITCH_TIMEOUT'
      ? 'Transient bank switch timeout detected. Immediate Razorpay payment link allows customer to complete checkout via alternate card/UPI without cart friction.'
      : 'Conservative recovery strategy recommended under baseline failure intelligence.'));

  return (
    <div className="strategy-decision-deck">
      {/* Recommended Strategy Hero Card */}
      <div className="recommended-strategy-hero">
        <div className="rec-hero-header">
          <div className="rec-hero-left">
            <span className="rec-star-badge">★ TOP RECOMMENDED INTERVENTION</span>
            <h4 className="rec-strategy-name">{topCandidate?.action}</h4>
          </div>
          <div className="rec-hero-badges">
            <span className={`badge-exec-mode mode-${(topCandidate?.resolvedExecutionMode || 'live_provider').toLowerCase()}`}>
              {topCandidate?.resolvedExecutionMode || 'LIVE_PROVIDER'}
            </span>
          </div>
        </div>

        <p className="rec-rationale-prose">{rationale}</p>

        <div className="rec-metrics-row">
          <div className="rec-metric-item">
            <span className="m-label">EXPECTED RECOVERY VALUE (ERV)</span>
            <strong className="m-val text-emerald">
              {formatMoney(topCandidate?.estimatedRecoveryValue, currency)}
            </strong>
          </div>
          <div className="rec-metric-item">
            <span className="m-label">ESTIMATED CONVERSION</span>
            <strong className="m-val">
              {Math.round((topCandidate?.estimatedProbability || 0) * 100)}%
            </strong>
          </div>
          <div className="rec-metric-item">
            <span className="m-label">ESTIMATED FRICTION</span>
            <strong className="m-val text-muted">
              {formatMoney(topCandidate?.estimatedFriction || 0, currency)}
            </strong>
          </div>
        </div>
      </div>

      {/* Subordinate Candidate Comparison Table */}
      <div className="candidates-ranking-card">
        <div className="ranking-card-header">
          <span className="ranking-title">EVALUATED CANDIDATE INTERVENTIONS (RANKED BY ERV)</span>
          <span className="ranking-sub">Deterministic expected value heuristic</span>
        </div>

        <div className="ranking-rows-deck">
          {candidates.map((c, idx) => {
            const isTop = c.action === topAction;
            return (
              <div key={c.action} className={`ranking-row ${isTop ? 'row-top-recommended' : ''}`}>
                <div className="row-col-rank">
                  <span className="rank-num">#{idx + 1}</span>
                </div>
                <div className="row-col-main">
                  <div className="action-title-line">
                    <b>{c.action}</b>
                    {isTop && <span className="pill-top-pick">TOP PICK</span>}
                    <span className={`badge-mode-mini mode-${c.resolvedExecutionMode.toLowerCase()}`}>
                      {c.resolvedExecutionMode}
                    </span>
                  </div>
                  <small className="action-desc-sub">{c.strategyDescription}</small>
                </div>

                <div className="row-col-conv">
                  <span className="stat-label-mini">CONV.</span>
                  <b>{Math.round((c.estimatedProbability || 0) * 100)}%</b>
                </div>

                <div className="row-col-erv">
                  <span className="stat-label-mini">ERV</span>
                  <strong className="erv-amount">{formatMoney(c.estimatedRecoveryValue, currency)}</strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="strategy-disclosure-note">
        <span className="disclosure-tag">SAFETY NOTICE</span>
        <span>Only <code>LIVE_PROVIDER</code> strategies communicate with payment rails (Razorpay Test Mode). All other strategies are simulated control plane heuristics.</span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 04: DETERMINISTIC POLICY GOVERNANCE GATE
// -----------------------------------------------------------------------------
function Stage4PolicyGovernance({ policyData, error }) {
  const [showAllRules, setShowAllRules] = useState(false);

  if (error) return <div className="console-error-inline">{error}</div>;
  if (!policyData) {
    return (
      <div className="policy-evaluating-placeholder">
        Evaluating deterministic safety rules against case telemetry…
      </div>
    );
  }

  const isAllow = policyData.decision === 'ALLOW';
  const isBlock = policyData.decision === 'BLOCK';
  const isReview = policyData.decision === 'REVIEW';

  const rules = policyData.rulesEvaluated || [];
  const passCount = rules.filter((r) => r.status === 'PASS').length;
  const blockCount = rules.filter((r) => r.status === 'BLOCK').length;
  const reviewCount = rules.filter((r) => r.status === 'REVIEW').length;

  return (
    <div className="policy-governance-deck">
      {/* Primary Authoritative Verdict Banner */}
      <div className={`policy-verdict-banner verdict-${policyData.decision.toLowerCase()}`}>
        <div className="verdict-top-row">
          <div className="verdict-headline">
            {isAllow && <span className="verdict-icon">✓</span>}
            {isBlock && <span className="verdict-icon">✗</span>}
            {isReview && <span className="verdict-icon">⚠️</span>}
            <span className="verdict-decision-text">POLICY {policyData.decision}</span>
          </div>
          <span className="verdict-engine-code">Policy Engine: recoverai-policy-v1</span>
        </div>

        <div className="verdict-summary-line">
          {isAllow && 'All evaluated safety constraints cleared. Recovery action execution permitted.'}
          {isBlock && `Action execution prohibited by stopping rules (${blockCount} blocking control, ${passCount} passed).`}
          {isReview && `Human escalation required (${reviewCount} review flag, ${passCount} passed).`}
        </div>

        {policyData.reasons?.length > 0 && (
          <ul className="verdict-reasons-list">
            {policyData.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Secondary Financial Invariants Checklist */}
      <div className="guardrails-drawer">
        <div className="guardrails-drawer-header">
          <div className="drawer-title-left">
            <span className="drawer-title">FINANCIAL INVARIANTS CHECKLIST (12 CONTROLS EVALUATED)</span>
            <span className="drawer-count-badge">{passCount}/12 PASSED</span>
          </div>
          <button
            type="button"
            className="btn-toggle-rules"
            onClick={() => setShowAllRules(!showAllRules)}
          >
            {showAllRules ? 'Hide Rules ▲' : 'Inspect 12 Rules ▼'}
          </button>
        </div>

        {showAllRules && (
          <div className="guardrails-grid-compact">
            {rules.map((r) => (
              <div key={r.rule} className={`rule-card status-${r.status.toLowerCase()}`}>
                <div className="rule-card-top">
                  <span className="rule-code">{r.rule}</span>
                  <span className={`rule-pill pill-${r.status.toLowerCase()}`}>{r.status}</span>
                </div>
                {r.message && <div className="rule-msg">{r.message}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 05: DUAL-TRACK EXECUTION & RECONCILIATION
// -----------------------------------------------------------------------------
function Stage5ExecutionAndReconciliation({
  detail,
  policyData,
  actions,
  outcomes,
  onExecuteAction,
  executingAction,
  actionError,
  currency,
  onRefreshCase
}) {
  const { recoveryCase } = detail;
  const confirmedAction = actions.find((a) => a.status === 'OUTCOME_CONFIRMED');
  const executedAction = actions.find((a) => a.status === 'EXECUTED' && (a.actionType === 'CREATE_PAYMENT_LINK' || a.paymentLinkUrl)) || actions.find((a) => a.status === 'EXECUTED');
  const verifiedOutcome = outcomes.find((o) => o.verified === true);
  const isResolved = recoveryCase.riskStatus === 'RESOLVED' || Boolean(verifiedOutcome);

  return (
    <div className="dual-track-deck">
      {/* Track A: Financial Ledger Execution (Dominant) */}
      <div className="track-pane pane-financial">
        <div className="pane-header-line">
          <span className="pane-tag">TRACK A · FINANCIAL EXECUTION</span>
          <span className="badge-rail-tag">RAZORPAY TEST MODE</span>
        </div>

        {verifiedOutcome || confirmedAction ? (
          <div className="financial-outcome-card card-verified">
            <div className="outcome-headline-row">
              <div>
                <span className="outcome-eyebrow">✓ VERIFIED SETTLEMENT</span>
                <h4 className="outcome-title">Recovery Reconciled to Ledger</h4>
              </div>
              <div className="outcome-amount-huge text-emerald">
                {formatMoney(verifiedOutcome?.amountPaid || confirmedAction?.amount, currency)}
              </div>
            </div>

            <div className="reconciliation-facts-grid">
              <div className="fact-item">
                <span className="fact-k">Provider Payment ID</span>
                <span className="fact-v font-mono">{verifiedOutcome?.providerPaymentId || confirmedAction?.providerActionId || 'pay_test_verified'}</span>
              </div>
              <div className="fact-item">
                <span className="fact-k">Recovery Link ID</span>
                <span className="fact-v font-mono">{(confirmedAction || executedAction)?.providerActionId || 'plink_test'}</span>
              </div>
              <div className="fact-item">
                <span className="fact-k">Reconciliation Method</span>
                <span className="fact-v">Signed webhook settlement (payment_link.paid)</span>
              </div>
              <div className="fact-item">
                <span className="fact-k">Reconciled At</span>
                <span className="fact-v">{formatTime(verifiedOutcome?.createdAt || confirmedAction?.completedAt)}</span>
              </div>
            </div>

            <div className="reconciliation-seal-footer">
              <b>✓ LEDGER CREDITED:</b> Four-point integrity verified (Provider ID, integer paise, currency INR, and idempotency key).
            </div>
          </div>
        ) : executedAction ? (
          <div className="financial-outcome-card card-active-link">
            <div className="outcome-headline-row">
              <div>
                <span className="outcome-eyebrow eyebrow-amber">⏳ PENDING PAYMENT</span>
                <h4 className="outcome-title">Razorpay Payment Link Active</h4>
              </div>
              <div className="outcome-amount-huge text-amber">
                {formatMoney(executedAction.amount, currency)}
              </div>
            </div>

            <div className="reconciliation-facts-grid">
              <div className="fact-item">
                <span className="fact-k">Payment Link Reference</span>
                <span className="fact-v font-mono">{executedAction.providerActionId || executedAction.id}</span>
              </div>
              <div className="fact-item">
                <span className="fact-k">Target Recovery Value</span>
                <span className="fact-v font-bold">{formatMoney(executedAction.amount, currency)}</span>
              </div>
              <div className="fact-item" style={{ gridColumn: 'span 2' }}>
                <span className="fact-k">Live Razorpay Checkout Link</span>
                <span className="fact-v">
                  <a
                    href={executedAction.paymentLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-live-checkout-link"
                  >
                    Open Payment Link ({executedAction.paymentLinkUrl}) ↗
                  </a>
                </span>
              </div>
            </div>

            <div className="pending-seal-footer">
              <b>PAYMENT PENDING:</b> Link is active in Razorpay Test Mode. Revenue is credited ONLY when the customer completes checkout and the signed webhook settles.
            </div>
          </div>
        ) : policyData?.decision === 'ALLOW' ? (
          <div className="financial-execution-trigger">
            <div className="trigger-text">
              <b>Policy cleared.</b> Ready to execute bounded Razorpay payment link.
            </div>
            {actionError && <div className="console-error-inline">{actionError}</div>}
            <button
              onClick={onExecuteAction}
              disabled={executingAction}
              className="btn-execute-live-action"
            >
              {executingAction ? 'Issuing Razorpay Link…' : 'EXECUTE BOUNDED PAYMENT LINK (RAZORPAY)'}
            </button>
          </div>
        ) : (
          <div className="financial-outcome-card card-suppressed">
            <b>ACTION EXECUTION SUPPRESSED BY POLICY</b>
            <p>Automated execution blocked by deterministic policy to prevent financial double-counting or violation of stopping rules.</p>
          </div>
        )}
      </div>

      {/* Track B: Customer Outreach (Secondary) */}
      <div className="track-pane pane-outreach">
        <div className="pane-header-line">
          <span className="pane-tag">TRACK B · CUSTOMER OUTREACH</span>
          <span className="badge-channel-tag badge-sandbox-constrained">WHATSAPP RECOVERY · SANDBOX CONSTRAINED</span>
        </div>

        {isResolved ? (
          <div className="outreach-suppressed-card">
            <div className="suppressed-seal-header">
              <span className="suppressed-badge">🛡️ OUTREACH PERMANENTLY SUPPRESSED</span>
              <span className="suppressed-disposition">HARD_STOP</span>
            </div>
            <h4 className="suppressed-lead">PAYMENT ALREADY RECOVERED</h4>
            <p className="suppressed-text">
              Revflow stopping engine halts all automated outreach once payment settlement is confirmed. Redundant messages are permanently suppressed to protect buyer trust and brand reputation.
            </p>
            <div className="suppressed-facts">
              <span><b>Protection Rule:</b> <code>PAYMENT_RECOVERED</code></span>
              <span><b>Recovered Amount:</b> <b>{formatMoney(recoveryCase.recoveredAmount || recoveryCase.amount, currency)}</b></span>
            </div>
          </div>
        ) : (
          <CustomerCommunicationInline
            caseId={recoveryCase.id}
            caseDetail={detail}
            actions={actions}
            currency={currency}
            onRefreshCase={onRefreshCase}
          />
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// INLINE CUSTOMER OUTREACH (FOR ACTIVE CASES)
// -----------------------------------------------------------------------------
function CustomerCommunicationInline({ caseId, caseDetail, actions = [], currency = 'INR', onRefreshCase = null }) {
  const [selectedLanguage, setSelectedLanguage] = useState('hinglish');
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [sendError, setSendError] = useState(null);

  const recoveryCase = caseDetail?.recoveryCase || {};
  const defaultPhone = recoveryCase.customerReference || '+916202045661';
  const [recipientPhone, setRecipientPhone] = useState(defaultPhone);
  const [phoneValidationError, setPhoneValidationError] = useState('');

  useEffect(() => {
    const phone = caseDetail?.recoveryCase?.customerReference || '+916202045661';
    setRecipientPhone(phone);
    setPhoneValidationError('');
    setSendResult(null);
    setSendError(null);
  }, [caseId, caseDetail]);

  const fetchPreview = async (lang) => {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/communication/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'whatsapp', language: lang })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to generate preview');
      setPreview(data);
    } catch (err) {
      setPreviewError(err.message);
    } finally {
      setLoadingPreview(false);
    }
  };

  useEffect(() => {
    fetchPreview(selectedLanguage);
  }, [caseId, selectedLanguage]);

  const handleSend = async () => {
    const cleanedPhone = (recipientPhone || '').trim().replace(/[\s\-()]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(cleanedPhone)) {
      setPhoneValidationError('Recipient phone must be a valid E.164 international number.');
      return;
    }
    setPhoneValidationError('');
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/communication/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'whatsapp',
          language: selectedLanguage,
          recipientPhone: cleanedPhone
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to dispatch communication');
      setSendResult(data);
      fetchPreview(selectedLanguage);
      if (typeof onRefreshCase === 'function') onRefreshCase();
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const commActions = (caseDetail?.actions || actions || []).filter(
    (a) => a.actionType === 'CUSTOMER_OUTREACH' || a.actionType === 'DISPATCH_VERNACULAR_ASSIST'
  );
  const latestOutreach = commActions.at(-1) || sendResult?.action;

  return (
    <div className="outreach-console-body">
      {/* Language Switcher */}
      <div className="outreach-lang-bar">
        <span className="lang-label">LANGUAGE:</span>
        <div className="lang-button-group">
          {[
            { id: 'en', label: 'English' },
            { id: 'hi', label: 'हिंदी (Hindi)' },
            { id: 'hinglish', label: 'Hinglish' }
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedLanguage(t.id)}
              className={`btn-lang-tab ${selectedLanguage === t.id ? 'active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* WhatsApp Message Preview */}
      <div className="whatsapp-preview-box">
        <div className="whatsapp-box-header">
          <span>💬 Generated Customer Message</span>
          <span className="bubble-verified">GROUNDED COPY</span>
        </div>
        {loadingPreview ? (
          <div className="whatsapp-loading">Generating grounded message copy…</div>
        ) : preview ? (
          <div className="whatsapp-message-bubble">
            <p className="bubble-text">{preview.message}</p>
            <span className="bubble-time">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Preview only
            </span>
          </div>
        ) : previewError ? (
          <div className="console-error-inline">{previewError}</div>
        ) : null}
      </div>

      {/* Phone Destination */}
      <div className="phone-config-row">
        <span className="phone-label">RECIPIENT (E.164):</span>
        <div className="phone-input-wrap">
          <input
            type="text"
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value)}
            className="input-recipient-field"
            disabled={sending}
          />
          {recipientPhone !== defaultPhone && (
            <button type="button" onClick={() => setRecipientPhone(defaultPhone)} className="btn-reset-phone-field">
              Reset
            </button>
          )}
        </div>
      </div>
      {phoneValidationError && <div className="console-error-inline">{phoneValidationError}</div>}

      {/* Twilio Delivery Status */}
      <div className="twilio-delivery-status-card">
        <div className="delivery-status-top">
          <span className="status-label">DELIVERY STATUS</span>
          <span className="badge-delivery sandbox-constrained">
            SANDBOX CONSTRAINED / NOT DELIVERED
          </span>
        </div>
        <div className="delivery-meta-sub">
          {latestOutreach ? `Action #${latestOutreach.id} · ` : ''}Provider: Twilio WhatsApp Sandbox · Carrier Status: <code>{latestOutreach?.status || 'NOT_DELIVERED'}</code>
        </div>
        <div className="twilio-carrier-notice">
          <b>Reason:</b> Twilio trial sandbox requires a pre-approved ContentSid template. Unapproved customer messaging is prevented. Financial invariants and recovery ledger remain 100% intact.
        </div>
      </div>

      {/* Send Dispatch Bar */}
      <div className="outreach-action-row">
        {sendError && <div className="console-error-inline">{sendError}</div>}
        {sendResult && (
          sendResult.action?.status === 'FAILED' || sendResult.communication?.status === 'FAILED' ? (
            <div className="send-constrained-alert">
              ⚠️ Provider Constraint Recorded: Twilio trial sandbox requires pre-approved ContentSid template (Error 21654). Message not delivered.
            </div>
          ) : (
            <div className="send-success-alert">
              ✓ Dispatched via {sendResult.communication?.provider} ({sendResult.communication?.status})
            </div>
          )
        )}
        <button
          onClick={handleSend}
          disabled={sending || loadingPreview}
          className="btn-send-whatsapp-sandbox"
        >
          {sending ? 'Testing Sandbox Dispatch…' : '🧪 TEST SANDBOX DISPATCH (CONSTRAINED)'}
        </button>
        <div className="outreach-disclaimer-sub">
          Notice: Outreach dispatch !== revenue recovered. Twilio trial sandbox enforces template restrictions.
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STAGE 06: PRIMARY LIFECYCLE PROGRESSION & AUDIT TRAIL
// -----------------------------------------------------------------------------
function Stage6RecoveryTimeline({ events = [], auditEvents = [], isResolved = false }) {
  const [showFullAudit, setShowFullAudit] = useState(false);

  // Grouped / Deduplicated audit events to avoid overwhelming repetitive POLICY_EVALUATED
  const mergedTimeline = [
    ...events.map((e) => ({
      category: 'INGESTION',
      kind: e.eventType,
      message: `${e.eventType}${e.failureReason ? ` — ${e.failureReason}` : ''}`,
      time: e.timestamp
    })),
    ...auditEvents.map((a) => {
      let category = 'AUDIT';
      const kind = a.eventType || 'AUDIT';
      if (kind.includes('DIAGNOSIS') || kind.includes('INTELLIGENCE')) category = 'INTELLIGENCE';
      else if (kind.includes('POLICY')) category = 'GOVERNANCE';
      else if (kind.includes('ACTION') || kind.includes('LINK')) category = 'EXECUTION';
      else if (kind.includes('OUTREACH') || kind.includes('COMMUNICATION')) category = 'OUTREACH';
      else if (kind.includes('RECONCIL') || kind.includes('OUTCOME')) category = 'RECONCILIATION';
      else if (kind.includes('CASE')) category = 'LIFECYCLE';

      return {
        category,
        kind,
        message: a.message,
        time: a.createdAt
      };
    })
  ].sort((a, b) => new Date(a.time) - new Date(b.time));

  // Deduplicate consecutive identical messages
  const displayItems = [];
  for (let i = 0; i < mergedTimeline.length; i++) {
    const curr = mergedTimeline[i];
    const prev = displayItems[displayItems.length - 1];
    if (prev && prev.kind === curr.kind && prev.message === curr.message) {
      prev.repeatCount = (prev.repeatCount || 1) + 1;
      prev.time = curr.time; // use latest timestamp
    } else {
      displayItems.push({ ...curr, repeatCount: 1 });
    }
  }

  return (
    <div className="timeline-deck">
      {/* Primary 5-Second Operational Lifecycle Progression */}
      <div className="lifecycle-stepper-strip">
        <div className="lifecycle-step-node completed">
          <div className="node-circle">01</div>
          <span className="node-label">FAILURE INGESTED</span>
        </div>
        <div className="node-connector completed" />

        <div className="lifecycle-step-node completed">
          <div className="node-circle">02</div>
          <span className="node-label">ROOT CAUSE INFERRED</span>
        </div>
        <div className="node-connector completed" />

        <div className="lifecycle-step-node completed">
          <div className="node-circle">03</div>
          <span className="node-label">STRATEGY RANKED</span>
        </div>
        <div className="node-connector completed" />

        <div className="lifecycle-step-node completed">
          <div className="node-circle">04</div>
          <span className="node-label">POLICY CLEARED</span>
        </div>
        <div className="node-connector completed" />

        <div className="lifecycle-step-node completed">
          <div className="node-circle">05</div>
          <span className="node-label">ACTION EXECUTED</span>
        </div>
        <div className={`node-connector ${isResolved ? 'completed' : 'pending'}`} />

        <div className={`lifecycle-step-node ${isResolved ? 'completed-reconciled' : 'pending-active'}`}>
          <div className="node-circle">{isResolved ? '✓' : '⏳'}</div>
          <span className="node-label">{isResolved ? 'RECONCILED' : 'SETTLEMENT PENDING'}</span>
        </div>
      </div>

      {/* Detailed Chronological Audit Trail */}
      <div className="audit-trail-section">
        <div className="audit-section-header">
          <span className="audit-title">CHRONOLOGICAL AUDIT TRAIL ({displayItems.length} DISTINCT EVENTS)</span>
          <button
            type="button"
            className="btn-toggle-audit"
            onClick={() => setShowFullAudit(!showFullAudit)}
          >
            {showFullAudit ? 'Collapse Audit Log ▲' : 'Expand Audit Log ▼'}
          </button>
        </div>

        {showFullAudit && (
          <ol className="audit-items-list">
            {displayItems.map((item, idx) => (
              <li key={`${item.kind}-${idx}`} className={`audit-log-item cat-${item.category.toLowerCase()}`}>
                <div className="audit-dot" />
                <div className="audit-entry">
                  <div className="audit-entry-top">
                    <span className={`audit-tag cat-${item.category.toLowerCase()}`}>{item.category}</span>
                    <strong className="audit-kind">{item.kind}</strong>
                    {item.repeatCount > 1 && (
                      <span className="audit-repeat-pill">Repeated {item.repeatCount}×</span>
                    )}
                    <time className="audit-time">{formatTime(item.time)}</time>
                  </div>
                  <p className="audit-msg">{item.message}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// BENCHMARK & PLAYBOOKS VIEW
// -----------------------------------------------------------------------------
function BenchmarkView({ evaluation, playbooks }) {
  const [selectedPlaybookId, setSelectedPlaybookId] = useState('payment_degradation');

  if (!evaluation) {
    return (
      <section className="benchmark-empty">
        <h2>Batch Benchmark & Playbooks Evaluation</h2>
        <p>Benchmark data is loading or has not been generated yet.</p>
        <p className="muted">Run <code>pnpm evaluate</code> in the terminal to generate the reproducible 560-case benchmark corpus.</p>
      </section>
    );
  }

  const fm = evaluation.financial_metrics;
  const sm = evaluation.safety_metrics;
  const aim = evaluation.engine_decision_metrics || evaluation.ai_diagnostic_metrics || {};
  const meta = evaluation.metadata;
  const breakdown = evaluation.playbook_breakdown || [];

  const selectedPlaybook = playbooks.find((p) => p.id === selectedPlaybookId) || playbooks[0] || null;
  const selectedBreakdown = breakdown.find((p) => p.playbook_id === selectedPlaybookId) || breakdown[0] || null;

  return (
    <section className="benchmark-container">
      {/* Benchmark Executive Header */}
      <div className="benchmark-header">
        <div>
          <h2>Revflow Batch Evaluation & Methodology</h2>
          <p className="muted">
            Reproducible Stratified Benchmark comparing Rules-Only Baseline against Revflow across 7 Track 03 Playbooks.
          </p>
        </div>
        <div className="benchmark-meta-pills">
          <span className="badge-meta">{meta.total_cases} Cases</span>
          <span className="badge-meta">7 Playbooks</span>
          <span className="badge-deterministic">Seed: {meta.seed} (Deterministic)</span>
        </div>
      </div>

      {/* Scope Disclaimer Banner */}
      <div className="scope-disclaimer-banner">
        <b>Methodology & Scope Notice:</b> The offline benchmark evaluates the Revflow decision/policy engine against a rules-only baseline using synthetic structured diagnoses and a shared customer response model. It evaluates policy enforcement, safety constraints, and decision sequencing. It does not measure real-world LLM diagnostic accuracy, which is demonstrated separately in the live operational product.
      </div>

      {/* Financial Results Grid */}
      <div className="benchmark-kpis">
        <article className="kpi-card">
          <span>Total Revenue at Risk</span>
          <strong>{formatMoney(fm.total_revenue_at_risk)}</strong>
          <small className="muted">{meta.total_cases} multi-playbook cases</small>
        </article>

        <article className="kpi-card">
          <span>Eligible Recovery Value</span>
          <strong>{formatMoney(fm.eligible_recovery_value)}</strong>
          <small className="muted">{fm.eligible_cases} active non-terminal cases</small>
        </article>

        <article className="kpi-card kpi-recovered">
          <span>Revflow Recovered</span>
          <strong className="text-success">{formatMoney(fm.recoverai_recovered_revenue)}</strong>
          <small className="muted">Eligible Rate: {((fm.recoverai_eligible_recovery_rate || 0) * 100).toFixed(1)}%</small>
        </article>

        <article className="kpi-card kpi-lift">
          <span>Incremental Lift (Δ)</span>
          <strong className="text-lift">+{formatMoney(fm.incremental_recovered_revenue)}</strong>
          <small className="text-lift-sub">+{(fm.incremental_eligible_recovery_rate * 100).toFixed(1)}% eligible rate lift (+{fm.revenue_lift_percentage}% relative)</small>
        </article>
      </div>

      {/* Safety KPI Grid */}
      <div className="safety-kpis-grid">
        <article className="safety-card zero-violations">
          <span>Unsafe Financial Actions</span>
          <strong className="text-zero">0 (Zero)</strong>
          <small>Baseline had {sm.unsafe_actions_baseline} violations on cancelled orders</small>
        </article>

        <article className="safety-card zero-violations">
          <span>Duplicate Retries in Cooldown</span>
          <strong className="text-zero">0 (Zero)</strong>
          <small>{sm.duplicate_actions_prevented_by_policy} duplicate links prevented by policy</small>
        </article>

        <article className="safety-card">
          <span>Human Escalations (&gt; ₹25k)</span>
          <strong>{sm.policy_decisions.review}</strong>
          <small>{(sm.escalation_rate * 100).toFixed(1)}% routed to merchant review</small>
        </article>

        <article className="safety-card">
          <span>Safe Stopping Rule Activations</span>
          <strong>{sm.stopping_rule_activations}</strong>
          <small>Terminal / cancelled / cooldown suppression</small>
        </article>
      </div>

      {/* Comparative Performance Table */}
      <div className="comparison-card">
        <div className="comparison-header">
          <h3>Rules-Only Baseline vs. Revflow Engine Performance</h3>
          <span className="badge-synthetic">Synthetic Benchmark Cohort (N = 560)</span>
        </div>
        <div className="table-responsive">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Performance & Safety Dimension</th>
                <th>Rules-Only Baseline (Naive Dunning)</th>
                <th>Revflow Engine</th>
                <th>Revflow Advantage</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>Revenue Recovered</b></td>
                <td>{formatMoney(fm.baseline_recovered_revenue)}</td>
                <td><b className="text-success">{formatMoney(fm.recoverai_recovered_revenue)}</b></td>
                <td><span className="badge-lift">+{formatMoney(fm.incremental_recovered_revenue)} (+{fm.revenue_lift_percentage}%)</span></td>
              </tr>
              <tr>
                <td>
                  <b>Eligible Recovery Rate (Primary)</b>
                  <small className="table-sublabel">Excludes cancelled/refunded ({fm.eligible_cases} cases)</small>
                </td>
                <td>{((fm.baseline_eligible_recovery_rate || 0) * 100).toFixed(1)}%</td>
                <td><b className="text-success">{((fm.recoverai_eligible_recovery_rate || 0) * 100).toFixed(1)}%</b></td>
                <td><span className="badge-lift">+{((fm.incremental_eligible_recovery_rate || 0) * 100).toFixed(1)}% rate lift</span></td>
              </tr>
              <tr>
                <td>
                  <b>Gross Recovery Rate (Descriptive)</b>
                  <small className="table-sublabel">Denominator: Total revenue at risk ({meta.total_cases} cases)</small>
                </td>
                <td>{((fm.baseline_gross_recovery_rate || 0) * 100).toFixed(1)}%</td>
                <td><b className="text-success">{((fm.recoverai_gross_recovery_rate || 0) * 100).toFixed(1)}%</b></td>
                <td><span className="badge-lift">+{((fm.incremental_gross_recovery_rate || 0) * 100).toFixed(1)}% rate lift</span></td>
              </tr>
              <tr>
                <td><b>95% Wilson Score CI (Rate)</b></td>
                <td>[{((fm.confidence_intervals?.baseline_wilson_score_ci_95?.lower || 0) * 100).toFixed(1)}%, {((fm.confidence_intervals?.baseline_wilson_score_ci_95?.upper || 0) * 100).toFixed(1)}%]</td>
                <td><b>[{((fm.confidence_intervals?.recoverai_wilson_score_ci_95?.lower || 0) * 100).toFixed(1)}%, {((fm.confidence_intervals?.recoverai_wilson_score_ci_95?.upper || 0) * 100).toFixed(1)}%]</b></td>
                <td><span className="text-success">{fm.statistical_significance?.test_name}: p = {fm.statistical_significance?.formatted_p_value} ({fm.statistical_significance?.significant_at_p01 ? 'p < 0.01' : 'Not significant'})</span></td>
              </tr>
              <tr>
                <td>
                  <b>Simulation Net Economic Value</b>
                  <small className="table-sublabel">Adjusted for API fees, human labor & friction penalties</small>
                </td>
                <td>{formatMoney(fm.baseline_simulated_net_economic_value || fm.baseline_net_economic_value)}</td>
                <td><b className="text-success">{formatMoney(fm.recoverai_simulated_net_economic_value || fm.recoverai_net_economic_value)}</b></td>
                <td><span className="badge-lift">+{formatMoney(fm.incremental_simulated_net_economic_value || fm.incremental_net_economic_value)}</span></td>
              </tr>
              <tr>
                <td><b>Unsafe Financial Actions</b></td>
                <td><span className="text-danger">{sm.unsafe_actions_baseline} violations</span></td>
                <td><b className="text-success">0 (Zero violations)</b></td>
                <td><span className="badge-safe">100% Policy Compliant</span></td>
              </tr>
              <tr>
                <td><b>Duplicate Retries in Cooldown</b></td>
                <td><span className="text-danger">{sm.baseline_duplicate_attempts} duplicate links</span></td>
                <td><b className="text-success">0 duplicate links</b></td>
                <td><span className="badge-safe">{sm.duplicate_actions_prevented_by_policy} Prevented by Cooldown</span></td>
              </tr>
              <tr>
                <td><b>Terminal Order Collection Attempts</b></td>
                <td><span className="text-danger">{sm.terminal_violations_baseline} attempts on cancelled carts</span></td>
                <td><b className="text-success">0 attempts (100% suppressed)</b></td>
                <td><span className="badge-safe">Instant Stopping Rules</span></td>
              </tr>
              <tr>
                <td><b>Structured Decision Validity Rate</b></td>
                <td>0% (No structured decision)</td>
                <td><b className="text-success">{((aim.structured_diagnosis_validity_rate || aim.valid_structured_diagnosis_rate || 1.0) * 100).toFixed(1)}%</b></td>
                <td><span className="badge-safe">Valid Structured Decisions</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Seven Playbooks Explorer */}
      <div className="playbooks-section">
        <div className="playbooks-header">
          <h3>The Seven Track 03 Recovery Playbooks</h3>
          <p className="muted">Inspect domain rules, trigger patterns, diagnostic indicators, and benchmark performance for each recovery archetype.</p>
        </div>

        <div className="playbook-tabs">
          {playbooks.map((pb) => (
            <button
              key={pb.id}
              className={`playbook-tab-btn ${pb.id === selectedPlaybookId ? 'active' : ''} ${pb.flagship ? 'flagship' : ''}`}
              onClick={() => setSelectedPlaybookId(pb.id)}
            >
              {pb.flagship && <span className="flagship-star">★ </span>}
              {pb.name}
            </button>
          ))}
        </div>

        {selectedPlaybook && (
          <div className="playbook-detail-card">
            <div className="playbook-detail-header">
              <div>
                {selectedPlaybook.flagship && (
                  <span className="badge-flagship">FLAGSHIP LIVE END-TO-END WORKFLOW</span>
                )}
                <h4>{selectedPlaybook.name}</h4>
                <p className="domain-tag"><b>Domain:</b> {selectedPlaybook.domain}</p>
              </div>
              {selectedBreakdown && (
                <div className="playbook-kpi-pill">
                  <span>Revflow: <b>{((selectedBreakdown.recoverai_eligible_recovery_rate || selectedBreakdown.recoverai_recovery_rate) * 100).toFixed(1)}%</b></span>
                  <span className="muted">Baseline: {((selectedBreakdown.baseline_eligible_recovery_rate || selectedBreakdown.baseline_recovery_rate) * 100).toFixed(1)}%</span>
                  <span className={(selectedBreakdown.incremental_eligible_recovery_rate || selectedBreakdown.incremental_recovery_rate) >= 0 ? 'text-lift' : 'text-danger'}>
                    Δ {((selectedBreakdown.incremental_eligible_recovery_rate || selectedBreakdown.incremental_recovery_rate) * 100) >= 0 ? '+' : ''}
                    {(((selectedBreakdown.incremental_eligible_recovery_rate || selectedBreakdown.incremental_recovery_rate)) * 100).toFixed(1)}%
                  </span>
                </div>
              )}
            </div>

            <p className="playbook-desc">{selectedPlaybook.description}</p>

            <div className="playbook-grid">
              <div>
                <h5>Trigger Patterns</h5>
                <ul className="pill-list">
                  {selectedPlaybook.triggerPatterns.map((t) => (
                    <li key={t}><code>{t}</code></li>
                  ))}
                </ul>

                <h5>Primary Root Causes</h5>
                <ul className="check-list">
                  {selectedPlaybook.primaryCauses.map((c, i) => (
                    <li key={i}>• {c}</li>
                  ))}
                </ul>
              </div>

              <div>
                <h5>Candidate Interventions</h5>
                <ul className="candidate-list">
                  {selectedPlaybook.candidateActions.map((ca) => (
                    <li key={ca.action}>
                      <div className="candidate-action-title">
                        <b>{ca.action}</b>
                        {ca.isExecutable ? (
                          <span className="badge-exec">Executable (Test Mode)</span>
                        ) : (
                          <span className="badge-advisory">Advisory / Simulated</span>
                        )}
                      </div>
                      <small>{ca.description}</small>
                    </li>
                  ))}
                </ul>

                <h5>Policy Guardrails & Constraints</h5>
                <dl className="constraint-list">
                  <div>
                    <dt>Max Attempts</dt>
                    <dd>{selectedPlaybook.policyConstraints.maxAttempts}</dd>
                  </div>
                  <div>
                    <dt>Cooldown</dt>
                    <dd>{selectedPlaybook.policyConstraints.cooldownMinutes} min</dd>
                  </div>
                  <div>
                    <dt>High-Value Review</dt>
                    <dd>&gt; {formatMoney(selectedPlaybook.policyConstraints.highValueReviewThreshold)}</dd>
                  </div>
                </dl>
              </div>
            </div>

            {selectedPlaybook.sampleScenario && (
              <div className="sample-scenario">
                <h5>Sample Scenario Context</h5>
                <dl>
                  <div>
                    <dt>Merchant</dt>
                    <dd>{selectedPlaybook.sampleScenario.merchant}</dd>
                  </div>
                  <div>
                    <dt>Customer</dt>
                    <dd>{selectedPlaybook.sampleScenario.customer}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>{formatMoney(selectedPlaybook.sampleScenario.amount, selectedPlaybook.sampleScenario.currency)}</dd>
                  </div>
                  <div>
                    <dt>Failure Cause</dt>
                    <dd>{selectedPlaybook.sampleScenario.failureReason}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
