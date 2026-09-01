/**
 * Revflow — The Seven Track 03 Recovery Playbooks
 *
 * All playbooks share the unified Revflow engine while encoding
 * domain-specific failure patterns, diagnostic indicators, and candidate actions.
 */

const RECOVERY_PLAYBOOKS = [
  {
    id: 'payment_degradation',
    name: 'Payment Degradation & Root Cause Recovery',
    domain: 'Core Gateway / E-Commerce Checkout',
    flagship: true,
    description: 'Pinpoints gateway or acquiring bank downtime, transient timeouts, and processing errors. Executes instant secondary payment link recovery with webhook outcome reconciliation.',
    triggerPatterns: [
      'BAD_GATEWAY',
      'GATEWAY_ERROR',
      'NETWORK_TIMEOUT',
      'BANK_DOWNTIME',
      'ACQUIRER_DEGRADATION'
    ],
    primaryCauses: [
      'Acquiring bank timeout during 3D-Secure authentication',
      'Intermittent payment gateway processing failure',
      'Card network communication outage'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Generate fresh Razorpay payment link with alternative routing', isExecutable: true },
      { action: 'REQUEST_MANUAL_REVIEW', description: 'Escalate to merchant operations if amount > ₹25,000 or high risk', isExecutable: false },
      { action: 'NO_ACTION', description: 'Abstain if case is terminal, refunded, or cooldown is active', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 2,
      cooldownMinutes: 30,
      highValueReviewThreshold: 2500000, // ₹25,000
      requiresTestModeVerification: true
    },
    sampleScenario: {
      merchant: 'QuickCart Retail',
      customer: 'Pooja Sharma',
      amount: 499900,
      currency: 'INR',
      failureReason: 'Gateway timeout during HDFC 3D-Secure challenge'
    }
  },
  {
    id: 'checkout_drop_off',
    name: 'Checkout Drop-off Recovery',
    domain: 'High-Intent Cart Abandonment',
    flagship: false,
    description: 'Detects high-intent cart abandonment and client-side auth hesitation. Generates personalized recovery links with cart context and expiry reminders.',
    triggerPatterns: [
      'CART_ABANDONED',
      'AUTH_HESITATION',
      'CHECKOUT_TIMEOUT',
      'CLIENT_SIDE_DROP'
    ],
    primaryCauses: [
      'Customer hesitated during OTP entry due to network lag',
      'Session expired before payment confirmation',
      'Multi-step checkout friction on mobile browser'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Generate personalized recovery link with cart items and 24h expiry', isExecutable: true },
      { action: 'REQUEST_MANUAL_REVIEW', description: 'Escalate high-value carts (> ₹25,000) for personal sales outreach', isExecutable: false },
      { action: 'NO_ACTION', description: 'Abstain if customer already completed a newer checkout session', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 2,
      cooldownMinutes: 60,
      highValueReviewThreshold: 2500000,
      requiresTestModeVerification: true
    },
    sampleScenario: {
      merchant: 'UrbanTrends Apparel',
      customer: 'Rahul Verma',
      amount: 349900,
      currency: 'INR',
      failureReason: 'Customer dropped off at OTP screen after 2 retry attempts'
    }
  },
  {
    id: 'failed_subscription',
    name: 'Failed-Subscription Recovery (Smart Dunning)',
    domain: 'SaaS & Recurring Billing',
    flagship: false,
    description: 'Manages recurring subscription auto-debit failures (insufficient funds, expired card tokens). Recommends backup payment links while respecting subscriber cancellation states.',
    triggerPatterns: [
      'INSUFFICIENT_FUNDS',
      'CARD_EXPIRED',
      'MANDATE_DECLINED',
      'RECURRING_AUTH_FAILED'
    ],
    primaryCauses: [
      'Card token expired or replaced by issuing bank',
      'Temporary insufficient balance on auto-debit charge date',
      'Bank recurring mandate limit exceeded'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Send instant backup card/UPI update payment link to subscriber', isExecutable: true },
      { action: 'SCHEDULE_RETRY_WINDOW', description: 'Schedule secondary auto-debit retry 48 hours later', isExecutable: false },
      { action: 'NO_ACTION', description: 'Immediately stop if subscription is cancelled or customer requested refund', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 3,
      cooldownMinutes: 1440, // 24 hours between dunning attempts
      highValueReviewThreshold: 5000000,
      stopOnCancellation: true
    },
    sampleScenario: {
      merchant: 'CloudScale SaaS',
      customer: 'DevOps Technologies Ltd',
      amount: 899900,
      currency: 'INR',
      failureReason: 'Recurring mandate declined due to token expiration'
    }
  },
  {
    id: 'b2b_receivables',
    name: 'B2B Receivables Chaser',
    domain: 'Wholesale & Invoicing',
    flagship: false,
    description: 'Handles overdue corporate invoices and receivables. Analyzes corporate approval lags vs invoice disputes, generating structured payment links and human escalation for high-value accounts.',
    triggerPatterns: [
      'INVOICE_OVERDUE',
      'PAYMENT_PENDING_APPROVAL',
      'DISPUTED_INVOICE',
      'CREDIT_TERMS_EXPIRED'
    ],
    primaryCauses: [
      'Corporate accounts payable workflow pending finance controller sign-off',
      'Invoice line-item mismatch under internal review',
      'Delayed vendor payment cycle'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Issue B2B instant NEFT/RTGS/UPI payment link with invoice reference', isExecutable: true },
      { action: 'REQUEST_MANUAL_REVIEW', description: 'Mandatory human review for invoices > ₹25,000 before contacting client', isExecutable: false },
      { action: 'NO_ACTION', description: 'Abstain if invoice is under formal dispute or credit note issued', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 2,
      cooldownMinutes: 4320, // 3 days
      highValueReviewThreshold: 2500000,
      requiresInvoiceReference: true
    },
    sampleScenario: {
      merchant: 'Apex Logistics Supplies',
      customer: 'Zenith Manufacturing Corp',
      amount: 4500000, // ₹45,000 -> requires review
      currency: 'INR',
      failureReason: 'Net-30 invoice overdue by 12 days; approval pending'
    }
  },
  {
    id: 'mandate_retry',
    name: 'Mandate Retry Sequencer',
    domain: 'UPI Autopay & e-Mandates',
    flagship: false,
    description: 'Sequences recurring UPI Autopay and EMI mandate retries around salary cycles (1st–5th of month) and bank processing windows, avoiding spammy consecutive declines.',
    triggerPatterns: [
      'UPI_MANDATE_FAILED',
      'AUTOPAY_SERVER_BUSY',
      'SALARY_CYCLE_MISMATCH',
      'EMI_DEBIT_FAILED'
    ],
    primaryCauses: [
      'Bank NPCI server congestion during month-end batch processing',
      'Salary not yet credited to customer account on debit date',
      'UPI app mandate authorization timeout'
    ],
    candidateActions: [
      { action: 'SCHEDULE_RETRY_WINDOW', description: 'Sequence auto-retry to post-salary date (3rd of month, 10:00 AM)', isExecutable: false },
      { action: 'CREATE_PAYMENT_LINK', description: 'Send direct UPI one-click payment link as ad-hoc alternative', isExecutable: true },
      { action: 'NO_ACTION', description: 'Abstain if maximum 3 mandate retries reached in current billing cycle', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 3,
      cooldownMinutes: 2880, // 48 hours
      highValueReviewThreshold: 2500000,
      alignWithSalaryCycle: true
    },
    sampleScenario: {
      merchant: 'FinGrowth Investments',
      customer: 'Amit Patel',
      amount: 250000,
      currency: 'INR',
      failureReason: 'Monthly SIP mandate failed: NPCI server timeout on 31st'
    }
  },
  {
    id: 'hinglish_voice_recovery',
    name: 'Hinglish Voice Recovery',
    domain: 'Tier-2/Tier-3 Vernacular Commerce',
    flagship: false,
    description: 'Assists vernacular customers who encounter payment confusion or language barriers during checkout. Generates localized conversational guidance and contextual WhatsApp/SMS payment links.',
    triggerPatterns: [
      'OTP_VERIFICATION_CONFUSION',
      'VERNACULAR_DROP_OFF',
      'COD_TO_PREPAID_FAILED',
      'UPI_PIN_ENTRY_ERROR'
    ],
    primaryCauses: [
      'Customer confused by English-only banking authorization page',
      'Incorrect UPI PIN entered twice due to interface ambiguity',
      'Hesitation converting Cash-on-Delivery to online prepaid discount'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Generate WhatsApp payment link accompanied by bilingual Hinglish summary', isExecutable: true },
      { action: 'REQUEST_MANUAL_REVIEW', description: 'Route to vernacular customer care specialist if order > ₹25,000', isExecutable: false },
      { action: 'NO_ACTION', description: 'Abstain outside permitted communication window (9:00 AM - 8:00 PM)', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 2,
      cooldownMinutes: 120,
      highValueReviewThreshold: 2500000,
      respectCallingWindow: true
    },
    sampleScenario: {
      merchant: 'DesiBazaar Crafts',
      customer: 'Suresh Kumar (Jaipur)',
      amount: 189900,
      currency: 'INR',
      failureReason: 'UPI PIN screen timeout; customer requested Hindi/Hinglish assistance'
    }
  },
  {
    id: 'promise_to_pay',
    name: 'Promise-to-Pay Tracker',
    domain: 'Collections & Delayed Commitments',
    flagship: false,
    description: 'Tracks customer commitments to pay on a specific future date (e.g., payday). Suppresses intrusive intermediate reminders until the promised timestamp, then executes structured reconciliation.',
    triggerPatterns: [
      'PROMISE_TO_PAY_RECORDED',
      'PAYDAY_COMMITMENT',
      'DELAYED_SETTLEMENT_AGREED',
      'COMMITMENT_DATE_REACHED'
    ],
    primaryCauses: [
      'Customer agreed to settle payment on upcoming payday (5th of month)',
      'Customer requested 3-day grace period following travel/hospitalization',
      'Scheduled payment deferral accepted by merchant'
    ],
    candidateActions: [
      { action: 'CREATE_PAYMENT_LINK', description: 'Trigger payment link at promised timestamp with grace period reminder', isExecutable: true },
      { action: 'REQUEST_MANUAL_REVIEW', description: 'Escalate to collections team if promised date passes without payment', isExecutable: false },
      { action: 'NO_ACTION', description: 'Strictly suppress all reminders prior to promised date', isExecutable: false }
    ],
    policyConstraints: {
      maxAttempts: 2,
      cooldownMinutes: 1440,
      highValueReviewThreshold: 2500000,
      honorCommitmentDate: true
    },
    sampleScenario: {
      merchant: 'EduMaster Online Academy',
      customer: 'Ananya Sen',
      amount: 750000,
      currency: 'INR',
      failureReason: 'Course fee installment deferred: customer committed to pay on 5th'
    }
  }
];

function getPlaybookById(playbookId) {
  return RECOVERY_PLAYBOOKS.find((p) => p.id === playbookId) || null;
}

function getAllPlaybooks() {
  return RECOVERY_PLAYBOOKS;
}

module.exports = { RECOVERY_PLAYBOOKS, getPlaybookById, getAllPlaybooks };