const baseUrl = process.env.RECOVERAI_API_URL || 'http://localhost:3001';

const scenarios = [
  { name: 'temporary payment failure', event: { eventId: 'sim_evt_001', eventType: 'payment.failed', paymentId: 'sim_pay_001', orderId: 'sim_order_001', amount: 499900, currency: 'INR', failureReason: 'timeout', customerReference: 'sim_customer_001', timestamp: '2026-08-31T10:00:00.000Z' } },
  { name: 'repeated payment failure', event: { eventId: 'sim_evt_002', eventType: 'payment.failed', paymentId: 'sim_pay_001', orderId: 'sim_order_001', amount: 499900, currency: 'INR', failureReason: 'bank_declined', customerReference: 'sim_customer_001', timestamp: '2026-08-31T10:01:00.000Z' } },
  { name: 'successful payment', event: { eventId: 'sim_evt_003', eventType: 'payment.captured', paymentId: 'sim_pay_002', orderId: 'sim_order_002', amount: 120000, currency: 'INR', customerReference: 'sim_customer_002', timestamp: '2026-08-31T10:02:00.000Z' } },
  { name: 'duplicate event', event: { eventId: 'sim_evt_002', eventType: 'payment.failed', paymentId: 'sim_pay_001', orderId: 'sim_order_001', amount: 499900, currency: 'INR', failureReason: 'bank_declined', customerReference: 'sim_customer_001', timestamp: '2026-08-31T10:01:00.000Z' } },
  { name: 'successful state after failure', event: { eventId: 'sim_evt_004', eventType: 'payment.captured', paymentId: 'sim_pay_001', orderId: 'sim_order_001', amount: 499900, currency: 'INR', customerReference: 'sim_customer_001', timestamp: '2026-08-31T10:03:00.000Z' } }
];

async function run() {
  for (const scenario of scenarios) {
    const response = await fetch(`${baseUrl}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenario.event) });
    const body = await response.json();
    console.log(`${scenario.name}: ${response.status} ${JSON.stringify(body)}`);
  }
}

run().catch((error) => { console.error(`Simulator failed: ${error.message}`); process.exitCode = 1; });
