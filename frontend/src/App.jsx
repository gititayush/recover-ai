import { useEffect, useMemo, useState } from 'react';

const formatMoney = (amount, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100);
const formatTime = (value) => new Date(value).toLocaleString();

export default function App() {
  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosisError, setDiagnosisError] = useState('');
  const [generatingDiagnosis, setGeneratingDiagnosis] = useState(false);
  const [error, setError] = useState('');

  async function loadCases() {
    try {
      const response = await fetch('/api/cases');
      if (!response.ok) throw new Error('Could not load recovery cases.');
      const body = await response.json();
      setCases(body.cases);
      if (body.cases.length && !selectedCase) selectCase(body.cases[0].id);
    } catch (loadError) { setError(loadError.message); }
  }

  async function selectCase(id) {
    setDiagnosis(null);
    setDiagnosisError('');
    const response = await fetch(`/api/cases/${id}`);
    if (response.ok) {
      setSelectedCase(await response.json());
      loadDiagnosis(id);
    }
  }

  async function loadDiagnosis(id) {
    const response = await fetch(`/api/cases/${id}/diagnosis`);
    if (response.ok) {
      const body = await response.json();
      setDiagnosis(body.diagnosis);
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
    } catch (diagnosisRequestError) { setDiagnosisError(diagnosisRequestError.message); }
    finally { setGeneratingDiagnosis(false); }
  }

  useEffect(() => { loadCases(); }, []);
  const openCases = useMemo(() => cases.filter((item) => ['OPEN', 'RECOVERABLE'].includes(item.riskStatus)), [cases]);
  const atRisk = useMemo(() => openCases.reduce((sum, item) => sum + item.amount, 0), [openCases]);

  return <main className="app-shell">
    <header><div><p className="eyebrow">Razorpay Buildathon 2026</p><h1>RecoverAI</h1><p>Revenue recovery operations, grounded in stored payment events.</p></div><button onClick={loadCases}>Refresh</button></header>
    {error && <p className="error">{error}</p>}
    <section className="metrics"><article><span>Open recovery cases</span><strong>{openCases.length}</strong></article><article><span>Revenue at risk</span><strong>{formatMoney(atRisk)}</strong></article></section>
    <section className="workspace"><aside><h2>Recovery cases</h2>{cases.length === 0 ? <p className="empty">No cases yet. Run the simulator after starting the backend.</p> : <ul>{cases.map((item) => <li key={item.id}><button className="case-row" onClick={() => selectCase(item.id)}><span><b>{item.paymentId}</b><small>{item.riskReason}</small></span><span className={`status ${item.riskStatus.toLowerCase()}`}>{item.riskStatus}</span><b>{formatMoney(item.amount, item.currency)}</b></button></li>)}</ul>}</aside>
      <article className="detail"><h2>Case details</h2>{!selectedCase ? <p className="empty">Select a case to inspect the evidence and audit trail.</p> : <CaseDetail detail={selectedCase} diagnosis={diagnosis} diagnosisError={diagnosisError} generatingDiagnosis={generatingDiagnosis} onGenerateDiagnosis={generateDiagnosis} />}</article>
    </section>
  </main>;
}

function CaseDetail({ detail, diagnosis, diagnosisError, generatingDiagnosis, onGenerateDiagnosis }) {
  const { recoveryCase, events, auditEvents } = detail;
  return <><dl><div><dt>Status</dt><dd>{recoveryCase.riskStatus}</dd></div><div><dt>Risk</dt><dd>{recoveryCase.riskLevel}</dd></div><div><dt>Value</dt><dd>{formatMoney(recoveryCase.amount, recoveryCase.currency)}</dd></div><div><dt>Order</dt><dd>{recoveryCase.orderId || '—'}</dd></div></dl><p className="reason">{recoveryCase.riskReason}</p><DiagnosisPanel diagnosis={diagnosis} error={diagnosisError} generating={generatingDiagnosis} onGenerate={onGenerateDiagnosis} currency={recoveryCase.currency} /><h3>Event and audit timeline</h3><ol className="timeline">{[...events.map((event) => ({ kind: event.eventType, message: `${event.eventType}${event.failureReason ? ` — ${event.failureReason}` : ''}`, time: event.timestamp })), ...auditEvents.map((audit) => ({ kind: audit.eventType, message: audit.message, time: audit.createdAt }))].sort((a, b) => new Date(a.time) - new Date(b.time)).map((item, index) => <li key={`${item.kind}-${index}`}><time>{formatTime(item.time)}</time><b>{item.kind}</b><span>{item.message}</span></li>)}</ol></>;
}

function DiagnosisPanel({ diagnosis, error, generating, onGenerate, currency }) {
  if (!diagnosis) return <section className="diagnosis"><h3>AI diagnosis</h3><p className="empty">No stored diagnosis.</p>{error && <p className="error">{error}</p>}<button onClick={onGenerate} disabled={generating}>{generating ? 'Generating…' : 'Generate diagnosis'}</button></section>;
  return <section className="diagnosis"><h3>AI diagnosis</h3><p><b>{diagnosis.diagnosis.cause}</b></p><dl><div><dt>Confidence</dt><dd>{Math.round(diagnosis.diagnosis.confidence * 100)}%</dd></div><div><dt>Recommendation</dt><dd>{diagnosis.recommendation.action}</dd></div><div><dt>Source</dt><dd>{diagnosis.source}</dd></div><div><dt>Prompt / model</dt><dd>{diagnosis.promptVersion} / {diagnosis.model}</dd></div></dl><h4>Evidence</h4><ul className="evidence">{diagnosis.diagnosis.evidence.map((item) => <li key={item.field}><code>{item.field}</code>: {item.value}</li>)}</ul><p className="selection">{diagnosis.recommendation.reason}</p><h4>Heuristic candidate estimates</h4><div className="candidates">{diagnosis.candidates.map((candidate) => <div key={candidate.action}><b>{candidate.action}</b><span>{Math.round(candidate.estimatedProbability * 100)}% probability · {formatMoney(candidate.estimatedRecoveryValue, currency)}</span></div>)}</div><p className="muted">Proposal only — no financial action has been executed.</p></section>;
}
