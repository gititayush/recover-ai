/**
 * Revflow V2 — Strategy Registry
 *
 * Establishes the authoritative catalog of revenue recovery strategies
 * with explicit execution modes:
 * - LIVE_PROVIDER: Only for verified external financial execution (currently CREATE_PAYMENT_LINK via Razorpay Test Mode)
 * - SIMULATED: Bounded advisory/planned interventions without live external side-effects
 * - CONTROL: Workflow governance, human escalation, or explicit stopping
 */

const EXECUTION_MODES = Object.freeze({
  LIVE_PROVIDER: 'LIVE_PROVIDER',
  SIMULATED: 'SIMULATED',
  CONTROL: 'CONTROL'
});

const STRATEGY_DEFINITIONS = Object.freeze({
  CREATE_PAYMENT_LINK: {
    id: 'CREATE_PAYMENT_LINK',
    name: 'Razorpay Payment Link',
    executionMode: EXECUTION_MODES.LIVE_PROVIDER,
    isLiveExecutable: true,
    provider: 'razorpay',
    description: 'Generate a bounded, idempotent Razorpay Payment Link with provider webhook verification and reconciliation.',
    defaultInterventionCostPaise: 0,
    defaultFrictionRate: 0.05,
    applicableCategories: [
      'TRANSIENT_PAYMENT_FAILURE',
      'CHECKOUT_DROPOFF',
      'FAILED_SUBSCRIPTION',
      'LANGUAGE_ASSISTANCE',
      'PROMISE_TO_PAY',
      'MANDATE_TIMING'
    ]
  },
  SCHEDULE_RETRY_WINDOW: {
    id: 'SCHEDULE_RETRY_WINDOW',
    name: 'Smart Retry Window',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Sequence an automated retry window aligned with merchant billing policies without customer notification.',
    defaultInterventionCostPaise: 500,
    defaultFrictionRate: 0.02,
    applicableCategories: [
      'FAILED_SUBSCRIPTION',
      'MANDATE_TIMING'
    ]
  },
  CHECKOUT_RECOVERY: {
    id: 'CHECKOUT_RECOVERY',
    name: 'Checkout Drop-off Recovery',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Generate a personalized recovery session with preserved cart items and checkout expiration.',
    defaultInterventionCostPaise: 200,
    defaultFrictionRate: 0.03,
    applicableCategories: [
      'CHECKOUT_DROPOFF'
    ]
  },
  CUSTOMER_OUTREACH: {
    id: 'CUSTOMER_OUTREACH',
    name: 'Customer Notification & Outreach',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Dispatch contextual reminder copy to the customer across verified communication channels.',
    defaultInterventionCostPaise: 100,
    defaultFrictionRate: 0.02,
    applicableCategories: [
      'CHECKOUT_DROPOFF',
      'FAILED_SUBSCRIPTION',
      'PROMISE_TO_PAY'
    ]
  },
  INVOICE_REMINDER: {
    id: 'INVOICE_REMINDER',
    name: 'B2B Invoice Reminder',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Issue a structured corporate accounts receivable reminder referencing invoice payment terms.',
    defaultInterventionCostPaise: 300,
    defaultFrictionRate: 0.04,
    applicableCategories: [
      'B2B_APPROVAL_DELAY'
    ]
  },
  DISPATCH_VERNACULAR_ASSIST: {
    id: 'DISPATCH_VERNACULAR_ASSIST',
    name: 'Vernacular Guidance Assist',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Provide multilingual checkout assistance copy (e.g. Hinglish / Hindi) to eliminate authorization confusion.',
    defaultInterventionCostPaise: 1000,
    defaultFrictionRate: 0.03,
    applicableCategories: [
      'LANGUAGE_ASSISTANCE'
    ]
  },
  RECORD_PROMISE_TO_PAY: {
    id: 'RECORD_PROMISE_TO_PAY',
    name: 'Promise-to-Pay Tracker',
    executionMode: EXECUTION_MODES.SIMULATED,
    isLiveExecutable: false,
    provider: null,
    description: 'Record customer payment commitment date and suppress intermediate recovery attempts until target date.',
    defaultInterventionCostPaise: 0,
    defaultFrictionRate: 0.0,
    applicableCategories: [
      'PROMISE_TO_PAY'
    ]
  },
  REQUEST_MANUAL_REVIEW: {
    id: 'REQUEST_MANUAL_REVIEW',
    name: 'Human Operations Escalation',
    executionMode: EXECUTION_MODES.CONTROL,
    isLiveExecutable: false,
    provider: null,
    description: 'Escalate case to merchant operations due to high financial exposure, low confidence, or policy constraints.',
    defaultInterventionCostPaise: 2500,
    defaultFrictionRate: 0.10,
    applicableCategories: [
      'TRANSIENT_PAYMENT_FAILURE',
      'CHECKOUT_DROPOFF',
      'FAILED_SUBSCRIPTION',
      'B2B_APPROVAL_DELAY',
      'MANDATE_TIMING',
      'LANGUAGE_ASSISTANCE',
      'PROMISE_TO_PAY',
      'AMBIGUOUS'
    ]
  },
  NO_ACTION: {
    id: 'NO_ACTION',
    name: 'Explicit Stop / No Intervention',
    executionMode: EXECUTION_MODES.CONTROL,
    isLiveExecutable: false,
    provider: null,
    description: 'Abstain from recovery intervention when case is terminal, refunded, uneconomic, or suppressed by policy.',
    defaultInterventionCostPaise: 0,
    defaultFrictionRate: 0.0,
    applicableCategories: [
      'TERMINAL_STATE',
      'TRANSIENT_PAYMENT_FAILURE',
      'CHECKOUT_DROPOFF',
      'FAILED_SUBSCRIPTION',
      'B2B_APPROVAL_DELAY',
      'MANDATE_TIMING',
      'LANGUAGE_ASSISTANCE',
      'PROMISE_TO_PAY',
      'AMBIGUOUS'
    ]
  }
});

function getStrategy(actionId) {
  if (!actionId || typeof actionId !== 'string') return null;
  return STRATEGY_DEFINITIONS[actionId] || null;
}

function listStrategies() {
  return Object.values(STRATEGY_DEFINITIONS);
}

function isLiveExecutable(actionId) {
  const strategy = getStrategy(actionId);
  return Boolean(strategy && strategy.executionMode === EXECUTION_MODES.LIVE_PROVIDER && strategy.isLiveExecutable);
}

function getLiveExecutableStrategies() {
  return listStrategies().filter((s) => s.executionMode === EXECUTION_MODES.LIVE_PROVIDER && s.isLiveExecutable);
}

function getStrategiesForCategory(category) {
  if (!category) return listStrategies();
  return listStrategies().filter((s) => s.applicableCategories.includes(category));
}

module.exports = {
  EXECUTION_MODES,
  STRATEGY_DEFINITIONS,
  getStrategy,
  listStrategies,
  isLiveExecutable,
  getLiveExecutableStrategies,
  getStrategiesForCategory
};
