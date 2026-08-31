const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const baseUrl = process.env.RECOVERAI_API_URL || 'http://localhost:3001';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!webhookSecret) {
  console.error('RAZORPAY_WEBHOOK_SECRET is required to replay signed Razorpay fixtures.');
  process.exit(1);
}

const fixtureDirectory = path.join(__dirname, '..', 'backend', 'test', 'fixtures', 'razorpay');
const scenarios = [
  ['replay_evt_failed_001', 'payment.failed.json'],
  ['replay_evt_authorized_001', 'payment.authorized.json'],
  ['replay_evt_captured_001', 'payment.captured.json'],
  ['replay_evt_order_paid_001', 'order.paid.json'],
  ['replay_evt_duplicate_001', 'payment.failed.minimal.json'],
  ['replay_evt_duplicate_001', 'payment.failed.minimal.json']
];

async function replay() {
  for (const [eventId, fileName] of scenarios) {
    const body = fs.readFileSync(path.join(fixtureDirectory, fileName));
    const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
    const response = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-event-id': eventId, 'x-razorpay-signature': signature },
      body
    });
    console.log(`${fileName} (${eventId}): ${response.status} ${await response.text()}`);
  }
}

replay().catch((error) => { console.error(`Razorpay fixture replay failed: ${error.message}`); process.exitCode = 1; });
