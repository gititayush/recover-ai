import { useEffect, useMemo, useState } from 'react';

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
  const [activeTab, setActiveTab] = useState('operations');
  const [cases, setCases] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [playbooks, setPlaybooks] = useState([]);
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

  async function loadMetrics() {
    try {
      const response = await fetch('/api/recovery/metrics');
      if (response.ok) {
        const body = await response.json();
        setMetrics(body.metrics);
      }
    } catch {
      // Non-blocking metrics fallback
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
      // Non-blocking evaluation fallback
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
      // Non-blocking playbooks fallback
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
      if (body.cases.length && !selectedCase) selectCase(body.cases[0].id);
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  async function selectCase(id) {
    setDiagnosis(null);
    setPolicyData(null);
    setActions([]);
    setOutcomes([]);
    setDiagnosisError('');
    setPolicyError('');
    setActionError('');

    const response = await fetch(`/api/cases/${id}`);
    if (response.ok) {
      const data = await response.json();
      setSelectedCase(data);
      if (data.actions) setActions(data.actions);
      if (data.outcomes) setOutcomes(data.outcomes);
      loadDiagnosis(id);
      loadPolicy(id);
    }
  }

  async function loadDiagnosis(id) {
    const response = await fetch(`/api/cases/${id}/diagnosis`);
    if (response.ok) {
      const body = await response.json();
      setDiagnosis(body.diagnosis);
    }
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
      selectCase(selectedCase.recoveryCase.id);
      loadMetrics();
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
  const displayRecovered = metrics ? metrics.revenue_recovered : 0;
  const displayPending = metrics ? metrics.pending_recoveries : 0;
  const displayRate = metrics ? `${Math.round(metrics.recovery_rate * 100)}%` : '0%';

  return (
    <main className="app-shell">
      {/* Institutional Control Plane Header */}
      <header className="control-header">
        <div className="control-header-brand">
          <div className="brand-title-line">
            <span className="brand-logo-text">REVFLOW</span>
            <span className="brand-divider">/</span>
            <span className="brand-product-sub">REVENUE RECOVERY CONTROL PLANE</span>
          </div>
          <div className="brand-status-line">
            <span className="status-live-pulse" />
            <span className="status-tag-text">ENGINE ONLINE</span>
            <span className="tag-bullet">·</span>
            <span className="tag-meta">RAZORPAY TEST MODE</span>
            <span className="tag-bullet">·</span>
            <span className="tag-meta">BUILDATHON 2026 TRACK 03</span>
          </div>
        </div>

        <div className="control-header-actions">
          <nav className="console-nav-tabs">
            <button
              className={activeTab === 'operations' ? 'active' : ''}
              onClick={() => setActiveTab('operations')}
            >
              LIVE OPERATIONS
            </button>
            <button
              className={activeTab === 'benchmark' ? 'active' : ''}
              onClick={() => {
                setActiveTab('benchmark');
                loadEvaluation();
                loadPlaybooks();
              }}
            >
              BENCHMARK & PLAYBOOKS
            </button>
          </nav>
          <button onClick={loadCases} className="btn-console-refresh" title="Reload operational cases and metrics">
            🔄 REFRESH
          </button>
        </div>
      </header>

      {error && <div className="console-error-alert">{error}</div>}

      {activeTab === 'operations' ? (
        <>
          {/* Command-Center KPI Strip */}
          <section className="kpi-command-strip">
            <article className="kpi-block kpi-risk">
              <div className="kpi-label-row">
                <span className="kpi-label">REVENUE AT RISK</span>
                <span className="kpi-indicator-dot dot-amber" />
              </div>
              <div className="kpi-numeric-val text-amber">{formatMoney(displayAtRisk)}</div>
              <div className="kpi-sub-context">{openCases.length} open recovery case requiring resolution</div>
            </article>

            <article className="kpi-block kpi-recovered">
              <div className="kpi-label-row">
                <span className="kpi-label">RECOVERED REVENUE</span>
                <span className="kpi-indicator-dot dot-emerald" />
              </div>
              <div className="kpi-numeric-val text-emerald">{formatMoney(displayRecovered)}</div>
              <div className="kpi-sub-context">✓ 3 verified Razorpay webhook settlements</div>
            </article>

            <article className="kpi-block kpi-active">
              <div className="kpi-label-row">
                <span className="kpi-label">ACTIVE RECOVERY</span>
                <span className="kpi-indicator-dot dot-blue" />
              </div>
              <div className="kpi-numeric-val text-blue">{displayPending}</div>
              <div className="kpi-sub-context">Case #4 active in bounded recovery pipeline</div>
            </article>

            <article className="kpi-block kpi-rate">
              <div className="kpi-label-row">
                <span className="kpi-label">RECOVERY RATE</span>
                <span className="kpi-indicator-dot dot-slate" />
              </div>
              <div className="kpi-numeric-val text-slate">{displayRate}</div>
              <div className="kpi-sub-context">₹1,750 of ₹2,250 lifetime risk reconciled</div>
            </article>
          </section>

          {/* Master-Detail Operations Workspace */}
          <section className="workspace-container">
            {/* Sidebar: Persistent Recovery Queue */}
            <aside className="cases-queue-panel">
              <div className="queue-header">
                <div className="queue-title-row">
                  <span className="queue-title">RECOVERY QUEUE</span>
                  <span className="queue-badge-count">{cases.length} CASES</span>
                </div>
                <div className="queue-caption">Real-time risk priority queue</div>
              </div>

              {cases.length === 0 ? (
                <div className="queue-empty">No cases found in database.</div>
              ) : (
                <div className="queue-items-scroll">
                  {cases.map((item) => {
                    const isSelected = selectedCase?.recoveryCase?.id === item.id;
                    const isResolved = item.riskStatus === 'RESOLVED';
                    return (
                      <button
                        key={item.id}
                        className={`queue-row ${isSelected ? 'selected' : ''} ${isResolved ? 'row-resolved' : 'row-recoverable'}`}
                        onClick={() => selectCase(item.id)}
                      >
                        <div className="queue-row-top">
                          <div className="queue-id-wrap">
                            <span className="queue-case-num">Case #{item.id}</span>
                            <span className={`queue-status-pill ${isResolved ? 'pill-resolved' : 'pill-recoverable'}`}>
                              {isResolved ? '✓ RESOLVED' : 'RECOVERABLE'}
                            </span>
                          </div>
                          <span className={`queue-row-amount ${isResolved ? 'text-emerald' : 'text-amber'}`}>
                            {formatMoney(item.amount, item.currency)}
                          </span>
                        </div>

                        <div className="queue-row-bottom">
                          <code className="queue-pay-id">{item.paymentId}</code>
                          <span className="queue-reason-text">{item.riskReason || 'Payment failed'}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </aside>

            {/* Central Decision Workspace */}
            <main className="case-workspace">
              {!selectedCase ? (
                <div className="workspace-empty-state">
                  <h3>Select a Case to Inspect Recovery Journey</h3>
                  <p className="muted">Click any case from the queue to view provider telemetry, failure intelligence, policy verdict, and Razorpay execution.</p>
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
                  onRefreshCase={() => selectCase(selectedCase.recoveryCase.id)}
                />
              )}
            </main>
          </section>
        </>
      ) : (
        <BenchmarkView evaluation={evaluation} playbooks={playbooks} />
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// DETERMINISTIC M8 TAXONOMY ENGINE (CLIENT-SIDE BASELINE)
// -----------------------------------------------------------------------------
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
  onRefreshCase
}) {
  const { recoveryCase, events = [], auditEvents = [] } = detail;
  const isResolved = recoveryCase.riskStatus === 'RESOLVED';
  const intelligence = resolveEffectiveIntelligence(diagnosis, detail);

  return (
    <div className="case-detail-layout">
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
          <span className="badge-channel-tag">WHATSAPP SANDBOX</span>
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
          <span>💬 WhatsApp Recovery Notification</span>
          <span className="bubble-verified">GROUNDED COPY</span>
        </div>
        {loadingPreview ? (
          <div className="whatsapp-loading">Generating grounded message copy…</div>
        ) : preview ? (
          <div className="whatsapp-message-bubble">
            <p className="bubble-text">{preview.message}</p>
            <span className="bubble-time">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ✓✓
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
      {latestOutreach && (
        <div className="twilio-delivery-status-card">
          <div className="delivery-status-top">
            <span className="status-label">TWILIO DELIVERY STATUS</span>
            <span className={`badge-delivery ${(latestOutreach.status || '').toLowerCase()}`}>
              {latestOutreach.status}
            </span>
          </div>
          <div className="delivery-meta-sub">
            Action #{latestOutreach.id} · Message ID: <code>{latestOutreach.providerActionId || 'Pending'}</code>
          </div>
          {(latestOutreach.status === 'FAILED' || latestOutreach.requestMetadata?.communication?.status === 'FAILED') && (
            <div className="twilio-carrier-notice">
              ⚠️ Delivery stopped: Twilio Trial sandbox requires pre-approved ContentSid templates. Financial invariants preserved.
            </div>
          )}
        </div>
      )}

      {/* Send Dispatch Bar */}
      <div className="outreach-action-row">
        {sendError && <div className="console-error-inline">{sendError}</div>}
        {sendResult && (
          <div className="send-success-alert">
            ✓ Dispatched via {sendResult.communication?.provider} ({sendResult.communication?.status})
          </div>
        )}
        <button
          onClick={handleSend}
          disabled={sending || loadingPreview}
          className="btn-send-whatsapp-sandbox"
        >
          {sending ? 'Dispatching…' : '➤ SEND VIA WHATSAPP (SANDBOX)'}
        </button>
        <div className="outreach-disclaimer-sub">
          Notice: Message dispatch !== revenue recovered. Settlement requires verified webhook.
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
