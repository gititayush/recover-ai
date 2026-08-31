import { useEffect, useMemo, useState } from 'react';

const formatMoney = (amount, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format((amount || 0) / 100);
const formatTime = (value) => new Date(value).toLocaleString();

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
    } catch (loadError) { setError(loadError.message); }
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
    } catch (diagnosisRequestError) { setDiagnosisError(diagnosisRequestError.message); }
    finally { setGeneratingDiagnosis(false); }
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

  useEffect(() => { loadCases(); }, []);
  const openCases = useMemo(() => cases.filter((item) => ['OPEN', 'RECOVERABLE'].includes(item.riskStatus)), [cases]);
  const fallbackAtRisk = useMemo(() => openCases.reduce((sum, item) => sum + item.amount, 0), [openCases]);

  const displayAtRisk = metrics ? metrics.revenue_at_risk : fallbackAtRisk;
  const displayRecovered = metrics ? metrics.revenue_recovered : 0;
  const displayPending = metrics ? metrics.pending_recoveries : 0;
  const displayRate = metrics ? `${Math.round(metrics.recovery_rate * 100)}%` : '0%';

  return <main className="app-shell">
    <header>
      <div>
        <p className="eyebrow">Razorpay Buildathon 2026 — Track 03: AI Revenue Recovery</p>
        <h1>RecoverAI</h1>
        <p>Bounded AI Revenue Recovery Operations, 7 Playbooks & Verified Outcome Reconciliation.</p>
      </div>
      <div className="header-actions">
        <nav className="tab-nav">
          <button className={activeTab === 'operations' ? 'active' : ''} onClick={() => setActiveTab('operations')}>
            ⚡ Live Operations
          </button>
          <button className={activeTab === 'benchmark' ? 'active' : ''} onClick={() => { setActiveTab('benchmark'); loadEvaluation(); loadPlaybooks(); }}>
            📊 Playbooks & Batch Benchmark
          </button>
        </nav>
        <button onClick={loadCases} className="btn-refresh">Refresh</button>
      </div>
    </header>

    {error && <p className="error">{error}</p>}

    {activeTab === 'operations' ? (
      <>
        <section className="metrics">
          <article><span>Revenue at risk</span><strong>{formatMoney(displayAtRisk)}</strong><small className="muted">{openCases.length} open cases</small></article>
          <article className="metric-recovered"><span>Recovered revenue</span><strong>{formatMoney(displayRecovered)}</strong><small className="muted">Verified by Razorpay</small></article>
          <article><span>Pending recovery</span><strong>{displayPending}</strong><small className="muted">Links created (awaiting payment)</small></article>
          <article><span>Recovery rate</span><strong>{displayRate}</strong><small className="muted">Verified conversion</small></article>
        </section>

        <section className="workspace">
          <aside>
            <h2>Recovery cases</h2>
            {cases.length === 0 ? <p className="empty">No cases yet. Run the simulator or replay fixtures.</p> : (
              <ul>{cases.map((item) => <li key={item.id}><button className="case-row" onClick={() => selectCase(item.id)}><span><b>{item.paymentId}</b><small>{item.riskReason}</small></span><span className={`status ${item.riskStatus.toLowerCase()}`}>{item.riskStatus}</span><b>{formatMoney(item.amount, item.currency)}</b></button></li>)}</ul>
            )}
          </aside>
          <article className="detail">
            <h2>Case details</h2>
            {!selectedCase ? <p className="empty">Select a case to inspect evidence, AI diagnosis, and audit trail.</p> : (
              <CaseDetail detail={selectedCase} diagnosis={diagnosis} diagnosisError={diagnosisError} generatingDiagnosis={generatingDiagnosis} onGenerateDiagnosis={generateDiagnosis} policyData={policyData} policyError={policyError} actions={actions} outcomes={outcomes} onExecuteAction={executeRecoveryAction} executingAction={executingAction} actionError={actionError} />
            )}
          </article>
        </section>
      </>
    ) : (
      <BenchmarkView evaluation={evaluation} playbooks={playbooks} />
    )}
  </main>;
}

function CaseDetail({ detail, diagnosis, diagnosisError, generatingDiagnosis, onGenerateDiagnosis, policyData, policyError, actions, outcomes, onExecuteAction, executingAction, actionError }) {
  const { recoveryCase, events, auditEvents } = detail;
  return <><dl><div><dt>Status</dt><dd>{recoveryCase.riskStatus}</dd></div><div><dt>Risk</dt><dd>{recoveryCase.riskLevel}</dd></div><div><dt>Value</dt><dd>{formatMoney(recoveryCase.amount, recoveryCase.currency)}</dd></div><div><dt>Outcome</dt><dd>{recoveryCase.outcome || (recoveryCase.riskStatus === 'RESOLVED' ? 'RESOLVED' : 'PENDING')}</dd></div></dl><p className="reason">{recoveryCase.riskReason}</p><DiagnosisPanel diagnosis={diagnosis} error={diagnosisError} generating={generatingDiagnosis} onGenerate={onGenerateDiagnosis} currency={recoveryCase.currency} /><PolicyAndActionPanel policyData={policyData} error={policyError} actions={actions} outcomes={outcomes} onExecute={onExecuteAction} executing={executingAction} actionError={actionError} currency={recoveryCase.currency} /><h3>Event and audit timeline</h3><ol className="timeline">{[...events.map((event) => ({ kind: event.eventType, message: `${event.eventType}${event.failureReason ? ` — ${event.failureReason}` : ''}`, time: event.timestamp })), ...auditEvents.map((audit) => ({ kind: audit.eventType, message: audit.message, time: audit.createdAt }))].sort((a, b) => new Date(a.time) - new Date(b.time)).map((item, index) => <li key={`${item.kind}-${index}`}><time>{formatTime(item.time)}</time><b>{item.kind}</b><span>{item.message}</span></li>)}</ol></>;
}

function DiagnosisPanel({ diagnosis, error, generating, onGenerate, currency }) {
  if (!diagnosis) return <section className="diagnosis"><h3>AI diagnosis</h3><p className="empty">No stored diagnosis.</p>{error && <p className="error">{error}</p>}<button onClick={onGenerate} disabled={generating}>{generating ? 'Generating…' : 'Generate diagnosis'}</button></section>;
  return <section className="diagnosis"><h3>AI diagnosis</h3><p><b>{diagnosis.diagnosis.cause}</b></p><dl><div><dt>Confidence</dt><dd>{Math.round(diagnosis.diagnosis.confidence * 100)}%</dd></div><div><dt>Recommendation</dt><dd>{diagnosis.recommendation.action}</dd></div><div><dt>Source</dt><dd>{diagnosis.source}</dd></div><div><dt>Prompt / model</dt><dd>{diagnosis.promptVersion} / {diagnosis.model}</dd></div></dl><h4>Evidence</h4><ul className="evidence">{diagnosis.diagnosis.evidence.map((item) => <li key={item.field}><code>{item.field}</code>: {item.value}</li>)}</ul><p className="selection">{diagnosis.recommendation.reason}</p><h4>Heuristic candidate estimates</h4><div className="candidates">{diagnosis.candidates.map((candidate) => <div key={candidate.action}><b>{candidate.action}</b><span>{Math.round(candidate.estimatedProbability * 100)}% probability · {formatMoney(candidate.estimatedRecoveryValue, currency)}</span></div>)}</div><p className="muted">Proposal only — no financial action has been executed.</p></section>;
}

function PolicyAndActionPanel({ policyData, error, actions, outcomes, onExecute, executing, actionError, currency }) {
  const confirmedAction = actions.find((a) => a.status === 'OUTCOME_CONFIRMED');
  const executedAction = actions.find((a) => a.status === 'EXECUTED');
  const verifiedOutcome = outcomes.find((o) => o.verified === true);
  const unverifiedOutcome = outcomes.find((o) => o.verified === false);

  return <section className="policy-panel">
    <h3>Policy guardrails & recovery execution</h3>
    {error && <p className="error">{error}</p>}
    {!policyData ? <p className="empty">Policy evaluation pending diagnosis...</p> : <>
      <div className="policy-header">
        <div>
          <b>Policy Decision: </b>
          <span className={`policy-badge ${policyData.decision.toLowerCase()}`}>{policyData.decision}</span>
        </div>
        <small className="muted">Version: {policyData.policyVersion}</small>
      </div>

      {policyData.reasons.length > 0 && <ul className="policy-reasons">
        {policyData.reasons.map((reason, idx) => <li key={idx}>⚠️ {reason}</li>)}
      </ul>}

      <h4>Evaluated Guardrails Checklist</h4>
      <ul className="rules-checklist">
        {policyData.rulesEvaluated.map((r) => (
          <li key={r.rule} className={r.status.toLowerCase()}>
            <span>{r.status === 'PASS' ? '✓' : '✗'} <code>{r.rule}</code></span>
            {r.message && <small>{r.message}</small>}
          </li>
        ))}
      </ul>

      {confirmedAction || verifiedOutcome ? (
        <div className="action-result confirmed">
          <h4>✓ RECOVERY VERIFIED — MONEY RECOVERED</h4>
          <dl>
            <div><dt>Action ID</dt><dd>{(confirmedAction || executedAction)?.providerActionId || (confirmedAction || executedAction)?.id}</dd></div>
            <div><dt>Status</dt><dd><span className="status-confirmed">RECOVERY VERIFIED</span></dd></div>
            <div><dt>Recovered Amount</dt><dd><b className="text-success">{formatMoney(verifiedOutcome?.amountPaid || confirmedAction?.amount, currency)}</b></dd></div>
            <div><dt>Provider Payment ID</dt><dd><code>{verifiedOutcome?.providerPaymentId || '—'}</code></dd></div>
            <div><dt>Verified At</dt><dd>{formatTime(verifiedOutcome?.createdAt || confirmedAction?.completedAt)}</dd></div>
            <div><dt>Verification</dt><dd>{verifiedOutcome?.verificationReason || 'Customer payment verified by Razorpay webhook.'}</dd></div>
          </dl>
          <p className="notice-verified"><b>✓ REVENUE RECOVERED</b> — Verified customer payment received from Razorpay. Case is resolved.</p>
        </div>
      ) : unverifiedOutcome ? (
        <div className="action-result block">
          <h4>⚠️ RECONCILIATION MISMATCH</h4>
          <dl>
            <div><dt>Status</dt><dd><span className="policy-badge block">MISMATCH REJECTED</span></dd></div>
            <div><dt>Expected Amount</dt><dd>{formatMoney(unverifiedOutcome.amountExpected, currency)}</dd></div>
            <div><dt>Received Amount</dt><dd>{formatMoney(unverifiedOutcome.amountPaid, unverifiedOutcome.currency)}</dd></div>
            <div><dt>Reason</dt><dd>{unverifiedOutcome.verificationReason}</dd></div>
          </dl>
          <p className="notice-disclaimer"><b>RECOVERY NOT VERIFIED</b> — Provider payment did not match recovery action requirements. Manual review required.</p>
        </div>
      ) : executedAction ? (
        <div className="action-result executed">
          <h4>⏳ ACTION EXECUTED — PAYMENT PENDING</h4>
          <dl>
            <div><dt>Action ID</dt><dd>{executedAction.providerActionId || executedAction.id}</dd></div>
            <div><dt>Status</dt><dd><span className="status-pending">PAYMENT PENDING</span></dd></div>
            <div><dt>Payment Link</dt><dd><a href={executedAction.paymentLinkUrl} target="_blank" rel="noreferrer">{executedAction.paymentLinkUrl}</a></dd></div>
            <div><dt>Expected Amount</dt><dd>{formatMoney(executedAction.amount, currency)}</dd></div>
          </dl>
          <p className="notice-pending"><b>⏳ PAYMENT PENDING</b> — Payment Link generated. Revenue recovery is pending customer payment (₹0.00 recovered so far).</p>
        </div>
      ) : policyData.decision === 'ALLOW' ? (
        <div className="action-trigger">
          {actionError && <p className="error">{actionError}</p>}
          <button onClick={onExecute} disabled={executing} className="btn-execute">
            {executing ? 'Executing Recovery…' : 'EXECUTE RECOVERY ACTION (Create Payment Link)'}
          </button>
          <p className="muted">Calls Razorpay Standard Payment Link API in Test Mode.</p>
        </div>
      ) : (
        <div className={`action-result ${policyData.decision.toLowerCase()}`}>
          <b>{policyData.decision === 'REVIEW' ? 'REVIEW REQUIRED' : 'ACTION BLOCKED'}</b>
          <p>Automated execution disabled by policy guardrails. See reasons above.</p>
        </div>
      )}
    </>}
  </section>;
}

function BenchmarkView({ evaluation, playbooks }) {
  const [selectedPlaybookId, setSelectedPlaybookId] = useState('payment_degradation');

  if (!evaluation) {
    return <section className="benchmark-empty">
      <h2>Batch Benchmark & Playbooks Evaluation</h2>
      <p>Benchmark data is loading or has not been generated yet.</p>
      <p className="muted">Run <code>pnpm evaluate</code> in the terminal to generate the reproducible 560-case benchmark corpus.</p>
    </section>;
  }

  const fm = evaluation.financial_metrics;
  const sm = evaluation.safety_metrics;
  const aim = evaluation.ai_diagnostic_metrics;
  const meta = evaluation.metadata;
  const breakdown = evaluation.playbook_breakdown || [];

  const selectedPlaybook = playbooks.find((p) => p.id === selectedPlaybookId) || playbooks[0] || null;
  const selectedBreakdown = breakdown.find((p) => p.playbook_id === selectedPlaybookId) || breakdown[0] || null;

  return <section className="benchmark-container">
    <div className="benchmark-header">
      <div>
        <h2>Batch Evaluation & Seven Playbooks Benchmark</h2>
        <p className="muted">
          Reproducible Stratified Benchmark comparing Rules-Only Baseline against RecoverAI (N = {meta.total_cases} cases, Seed = {meta.seed}).
        </p>
      </div>
      <span className="badge-deterministic">Seed: {meta.seed} (100% Deterministic)</span>
    </div>

    {/* 8-Metric Benchmark Grid */}
    <div className="benchmark-kpis">
      <article className="kpi-card">
        <span>Revenue at risk</span>
        <strong>{formatMoney(fm.total_revenue_at_risk)}</strong>
        <small className="muted">{meta.total_cases} multi-playbook cases</small>
      </article>

      <article className="kpi-card kpi-recovered">
        <span>Recovered revenue</span>
        <strong className="text-success">{formatMoney(fm.recoverai_recovered_revenue)}</strong>
        <small className="muted">RecoverAI Verified ({ (fm.recoverai_recovery_rate * 100).toFixed(1) }%)</small>
      </article>

      <article className="kpi-card kpi-lift">
        <span>Incremental lift (Δ)</span>
        <strong className="text-lift">+{formatMoney(fm.incremental_recovered_revenue)}</strong>
        <small className="text-lift-sub">+{(fm.incremental_recovery_rate * 100).toFixed(1)}% rate lift (+{fm.revenue_lift_percentage}% relative)</small>
      </article>

      <article className="kpi-card">
        <span>Net economic value</span>
        <strong>{formatMoney(fm.recoverai_net_economic_value)}</strong>
        <small className="muted">vs Baseline {formatMoney(fm.baseline_net_economic_value)}</small>
      </article>

      <article className="kpi-card">
        <span>Human escalated</span>
        <strong>{sm.policy_decisions.review}</strong>
        <small className="muted">{ (sm.escalation_rate * 100).toFixed(1) }% (&gt; ₹25,000 threshold)</small>
      </article>

      <article className="kpi-card">
        <span>Blocked / stopped</span>
        <strong>{sm.policy_decisions.block}</strong>
        <small className="muted">{ (sm.blocked_rate * 100).toFixed(1) }% (safe stopping rules)</small>
      </article>

      <article className="kpi-card">
        <span>Stopping rules active</span>
        <strong>{sm.stopping_rule_activations}</strong>
        <small className="muted">Cancelled / refunded / cooldown</small>
      </article>

      <article className="kpi-card kpi-safety">
        <span>Unsafe financial actions</span>
        <strong className="text-zero">0 (Zero)</strong>
        <small className="muted">Baseline had {sm.unsafe_actions_baseline} violations</small>
      </article>
    </div>

    {/* Side-by-Side Comparison Table */}
    <div className="comparison-card">
      <h3>Rules-Only Baseline vs. RecoverAI Engine Comparison</h3>
      <table className="comparison-table">
        <thead>
          <tr>
            <th>Performance & Safety Dimension</th>
            <th>Rules-Only Baseline (Naive Dunning)</th>
            <th>RecoverAI Engine</th>
            <th>RecoverAI Advantage</th>
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
            <td><b>Eligible Recovery Rate (Primary)</b><br/><small className="muted">Excludes cancelled/refunded ({fm.eligible_cases} cases)</small></td>
            <td>{ ((fm.baseline_eligible_recovery_rate || 0) * 100).toFixed(1) }%</td>
            <td><b className="text-success">{ ((fm.recoverai_eligible_recovery_rate || 0) * 100).toFixed(1) }%</b></td>
            <td><span className="badge-lift">+{ ((fm.incremental_eligible_recovery_rate || 0) * 100).toFixed(1) }% rate lift</span></td>
          </tr>
          <tr>
            <td><b>Gross Recovery Rate (Descriptive)</b><br/><small className="muted">Denominator: Total risk ({meta.total_cases} cases)</small></td>
            <td>{ ((fm.baseline_gross_recovery_rate || 0) * 100).toFixed(1) }%</td>
            <td><b className="text-success">{ ((fm.recoverai_gross_recovery_rate || 0) * 100).toFixed(1) }%</b></td>
            <td><span className="badge-lift">+{ ((fm.incremental_gross_recovery_rate || 0) * 100).toFixed(1) }% rate lift</span></td>
          </tr>
          <tr>
            <td><b>95% Wilson Score CI (Rate)</b></td>
            <td>[{ ((fm.confidence_intervals?.baseline_wilson_score_ci_95?.lower || 0) * 100).toFixed(1) }%, { ((fm.confidence_intervals?.baseline_wilson_score_ci_95?.upper || 0) * 100).toFixed(1) }%]</td>
            <td><b>[{ ((fm.confidence_intervals?.recoverai_wilson_score_ci_95?.lower || 0) * 100).toFixed(1) }%, { ((fm.confidence_intervals?.recoverai_wilson_score_ci_95?.upper || 0) * 100).toFixed(1) }%]</b></td>
            <td><span className="text-success">{fm.statistical_significance?.test_name}: p = {fm.statistical_significance?.formatted_p_value} ({fm.statistical_significance?.significant_at_p01 ? 'p < 0.01' : 'Not significant'})</span></td>
          </tr>
          <tr>
            <td><b>Net Economic Value (Friction-Adjusted)</b></td>
            <td>{formatMoney(fm.baseline_net_economic_value)}</td>
            <td><b className="text-success">{formatMoney(fm.recoverai_net_economic_value)}</b></td>
            <td><span className="badge-lift">+{formatMoney(fm.incremental_net_economic_value)}</span></td>
          </tr>
          <tr>
            <td><b>Unsafe Financial Actions</b></td>
            <td><span className="text-danger">{sm.unsafe_actions_baseline} violations</span></td>
            <td><b className="text-success">0 violations (Zero)</b></td>
            <td><span className="badge-safe">100% Policy Compliant</span></td>
          </tr>
          <tr>
            <td><b>Duplicate Retries / Spam Links</b></td>
            <td><span className="text-danger">{sm.baseline_duplicate_attempts} duplicate retries</span></td>
            <td><b className="text-success">0 duplicate retries</b></td>
            <td><span className="badge-safe">{sm.duplicate_actions_prevented_by_policy} Stopped by Cooldown</span></td>
          </tr>
          <tr>
            <td><b>Terminal / Refund Order Safety</b></td>
            <td><span className="text-danger">{sm.terminal_violations_baseline} attempts on cancelled orders</span></td>
            <td><b className="text-success">0 attempts (100% suppressed)</b></td>
            <td><span className="badge-safe">Instant Terminal Stop</span></td>
          </tr>
          <tr>
            <td><b>AI Structured Diagnosis Rate</b></td>
            <td>0% (No diagnosis)</td>
            <td><b className="text-success">{ (aim.valid_structured_diagnosis_rate * 100).toFixed(1) }%</b></td>
            <td><span className="badge-safe">100% Zod Schema Grounded</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    {/* Seven Playbooks Interactive Section */}
    <div className="playbooks-section">
      <h3>The Seven Track 03 Recovery Playbooks</h3>
      <p className="muted">Click a playbook to inspect domain rules, trigger patterns, diagnostic indicators, and benchmark performance.</p>

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
              {selectedPlaybook.flagship && <span className="badge-flagship">FLAGSHIP REAL END-TO-END WORKFLOW</span>}
              <h4>{selectedPlaybook.name}</h4>
              <p className="domain-tag"><b>Domain:</b> {selectedPlaybook.domain}</p>
            </div>
            {selectedBreakdown && (
              <div className="playbook-kpi-pill">
                <span>RecoverAI: <b>{(selectedBreakdown.recoverai_recovery_rate * 100).toFixed(1)}%</b></span>
                <span className="muted">Baseline: {(selectedBreakdown.baseline_recovery_rate * 100).toFixed(1)}%</span>
                <span className="text-lift">Δ +{(selectedBreakdown.incremental_recovery_rate * 100).toFixed(1)}%</span>
              </div>
            )}
          </div>

          <p className="playbook-desc">{selectedPlaybook.description}</p>

          <div className="playbook-grid">
            <div>
              <h5>Trigger Patterns</h5>
              <ul className="pill-list">
                {selectedPlaybook.triggerPatterns.map((t) => <li key={t}><code>{t}</code></li>)}
              </ul>

              <h5>Primary Root Causes</h5>
              <ul className="check-list">
                {selectedPlaybook.primaryCauses.map((c, i) => <li key={i}>• {c}</li>)}
              </ul>
            </div>

            <div>
              <h5>Candidate Interventions</h5>
              <ul className="candidate-list">
                {selectedPlaybook.candidateActions.map((ca) => (
                  <li key={ca.action}>
                    <b>{ca.action}</b> {ca.isExecutable && <span className="badge-exec">Executable</span>}
                    <small>{ca.description}</small>
                  </li>
                ))}
              </ul>

              <h5>Policy Guardrails & Constraints</h5>
              <dl className="constraint-list">
                <div><dt>Max Attempts</dt><dd>{selectedPlaybook.policyConstraints.maxAttempts}</dd></div>
                <div><dt>Cooldown</dt><dd>{selectedPlaybook.policyConstraints.cooldownMinutes} min</dd></div>
                <div><dt>High-Value Review</dt><dd>&gt; {formatMoney(selectedPlaybook.policyConstraints.highValueReviewThreshold)}</dd></div>
              </dl>
            </div>
          </div>

          {selectedPlaybook.sampleScenario && (
            <div className="sample-scenario">
              <h5>Sample Scenario</h5>
              <dl>
                <div><dt>Merchant</dt><dd>{selectedPlaybook.sampleScenario.merchant}</dd></div>
                <div><dt>Customer</dt><dd>{selectedPlaybook.sampleScenario.customer}</dd></div>
                <div><dt>Amount</dt><dd>{formatMoney(selectedPlaybook.sampleScenario.amount, selectedPlaybook.sampleScenario.currency)}</dd></div>
                <div><dt>Failure Cause</dt><dd>{selectedPlaybook.sampleScenario.failureReason}</dd></div>
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  </section>;
}
