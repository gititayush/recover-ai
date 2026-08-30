import { useEffect, useMemo, useState } from 'react';

const formatMoney = (amount, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100);
const formatTime = (value) => new Date(value).toLocaleString();

export default function App() {
  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
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
    const response = await fetch(`/api/cases/${id}`);
    if (response.ok) setSelectedCase(await response.json());
  }

  useEffect(() => { loadCases(); }, []);
  const openCases = useMemo(() => cases.filter((item) => ['OPEN', 'RECOVERABLE'].includes(item.riskStatus)), [cases]);
  const atRisk = useMemo(() => openCases.reduce((sum, item) => sum + item.amount, 0), [openCases]);

  return <main className="app-shell">
    <header><div><p className="eyebrow">Razorpay Buildathon 2026</p><h1>RecoverAI</h1><p>Revenue recovery operations, grounded in stored payment events.</p></div><button onClick={loadCases}>Refresh</button></header>
    {error && <p className="error">{error}</p>}
    <section className="metrics"><article><span>Open recovery cases</span><strong>{openCases.length}</strong></article><article><span>Revenue at risk</span><strong>{formatMoney(atRisk)}</strong></article></section>
    <section className="workspace"><aside><h2>Recovery cases</h2>{cases.length === 0 ? <p className="empty">No cases yet. Run the simulator after starting the backend.</p> : <ul>{cases.map((item) => <li key={item.id}><button className="case-row" onClick={() => selectCase(item.id)}><span><b>{item.paymentId}</b><small>{item.riskReason}</small></span><span className={`status ${item.riskStatus.toLowerCase()}`}>{item.riskStatus}</span><b>{formatMoney(item.amount, item.currency)}</b></button></li>)}</ul>}</aside>
      <article className="detail"><h2>Case details</h2>{!selectedCase ? <p className="empty">Select a case to inspect the evidence and audit trail.</p> : <CaseDetail detail={selectedCase} />}</article>
    </section>
  </main>;
}

function CaseDetail({ detail }) {
  const { recoveryCase, events, auditEvents } = detail;
  return <><dl><div><dt>Status</dt><dd>{recoveryCase.riskStatus}</dd></div><div><dt>Risk</dt><dd>{recoveryCase.riskLevel}</dd></div><div><dt>Value</dt><dd>{formatMoney(recoveryCase.amount, recoveryCase.currency)}</dd></div><div><dt>Order</dt><dd>{recoveryCase.orderId || '—'}</dd></div></dl><p className="reason">{recoveryCase.riskReason}</p><h3>Event and audit timeline</h3><ol className="timeline">{[...events.map((event) => ({ kind: event.eventType, message: `${event.eventType}${event.failureReason ? ` — ${event.failureReason}` : ''}`, time: event.timestamp })), ...auditEvents.map((audit) => ({ kind: audit.eventType, message: audit.message, time: audit.createdAt }))].sort((a, b) => new Date(a.time) - new Date(b.time)).map((item, index) => <li key={`${item.kind}-${index}`}><time>{formatTime(item.time)}</time><b>{item.kind}</b><span>{item.message}</span></li>)}</ol></>;
}
