/**
 * Revflow — Recovery Lab Service
 *
 * Provides safe, isolated simulation and demonstration of end-to-end
 * recovery flows across canonical failure scenarios.
 *
 * SAFETY INVARIANT:
 * All scenarios run strictly in an ephemeral InMemoryRecoveryRepository.
 * NEVER connects to or mutates the production PostgreSQL pool.
 * NEVER creates live Razorpay links or dispatches live WhatsApp messages.
 */

const { InMemoryRecoveryRepository } = require('../models/inMemoryRecoveryRepository');
const { processEvent } = require('./eventService');
const { extractProviderEvidence, classifyFailureEvidence } = require('../ai/failureTaxonomy');
const { evaluateCandidates, rankCandidates } = require('../ai/interventionEvaluator');
const { getStrategy } = require('../strategies/strategyRegistry');
const { evaluateStoppingCriteria } = require('../policy/stoppingEngine');
const { evaluatePolicy } = require('../policy/policyEngine');
const { executeSimulatedAction } = require('../actions/simulatedActionExecutor');

const DEMO_SCENARIOS = Object.freeze({
  BANK_SWITCH_TIMEOUT: {
    id: 'BANK_SWITCH_TIMEOUT',
    name: 'Issuer Bank Switch Timeout',
    category: 'MANDATE_TIMING',
    description: 'Transient acquiring switch timeout during high-volume bank processing. Smart retry sequences a quiet 15-minute window.',
    event: {
      eventId: 'lab_evt_bst_01',
      eventType: 'subscription.renewal_failed',
      paymentId: 'lab_pay_bst_01',
      orderId: 'lab_order_bst_01',
      amount: 150000, // ₹1,500
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Bank switch timeout during payment',
      customerReference: '+919876543210',
      timestamp: '2026-09-04T10:00:00.000Z',
      rawPayload: {
        subscriptionId: 'sub_lab_switch_01',
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_description: 'Bank switch timeout during 3D-Secure authentication'
      }
    }
  },

  INSUFFICIENT_FUNDS: {
    id: 'INSUFFICIENT_FUNDS',
    name: 'Account Insufficient Funds',
    category: 'FAILED_SUBSCRIPTION',
    description: 'Recurring auto-debit declined due to insufficient customer balance. Smart retry calculates a 48-hour replenishment backoff window.',
    event: {
      eventId: 'lab_evt_insuf_01',
      eventType: 'subscription.renewal_failed',
      paymentId: 'lab_pay_insuf_01',
      orderId: 'lab_order_insuf_01',
      amount: 250000, // ₹2,500
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Insufficient account balance',
      customerReference: '+919876543211',
      timestamp: '2026-09-04T10:00:00.000Z',
      rawPayload: {
        subscriptionId: 'sub_lab_insuf_01',
        error_code: 'INSUFFICIENT_FUNDS',
        error_source: 'customer',
        error_step: 'payment_authorization',
        error_description: 'Payment failed due to insufficient funds in account'
      }
    }
  },

  GATEWAY_TECHNICAL_FAILURE: {
    id: 'GATEWAY_TECHNICAL_FAILURE',
    name: 'Payment Gateway Technical Failure',
    category: 'TRANSIENT_PAYMENT_FAILURE',
    description: 'Intermittent internal gateway failure. Evaluator prioritizes alternative payment instrument (Payment Link) for immediate customer conversion.',
    event: {
      eventId: 'lab_evt_gtw_01',
      eventType: 'payment.failed',
      paymentId: 'lab_pay_gtw_01',
      orderId: 'lab_order_gtw_01',
      amount: 499900, // ₹4,999
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Gateway technical error',
      customerReference: '+919876543212',
      timestamp: '2026-09-04T10:00:00.000Z',
      rawPayload: {
        error_code: 'GATEWAY_ERROR',
        error_source: 'gateway',
        error_step: 'payment_processing',
        error_description: 'Upstream payment processing rail encountered an internal error'
      }
    }
  },

  UNKNOWN_FAILURE: {
    id: 'UNKNOWN_FAILURE',
    name: 'Generic Unknown Failure (Conservative Abstention)',
    category: 'AMBIGUOUS',
    description: 'Provider reported generic failure without technical telemetry. Revflow honestly abstains, caps confidence ≤ 0.35, and triggers policy review rather than hallucinating.',
    event: {
      eventId: 'lab_evt_unkn_01',
      eventType: 'payment.failed',
      paymentId: 'lab_pay_unkn_01',
      orderId: 'lab_order_unkn_01',
      amount: 80000, // ₹800
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Payment failed',
      customerReference: '+919876543213',
      timestamp: '2026-09-04T10:00:00.000Z',
      rawPayload: {
        status: 'failed'
      }
    }
  },

  ALREADY_RECOVERED: {
    id: 'ALREADY_RECOVERED',
    name: 'Already Recovered / Terminal Guard',
    category: 'TERMINAL_STATE',
    description: 'Payment was previously settled and confirmed. Stopping engine detects terminal settlement and blocks duplicate recovery interventions.',
    priorEvents: [
      {
        eventId: 'lab_evt_rec_01_failed',
        eventType: 'payment.failed',
        paymentId: 'lab_pay_rec_01',
        orderId: 'lab_order_rec_01',
        amount: 200000, // ₹2,000
        currency: 'INR',
        paymentStatus: 'failed',
        failureReason: 'Initial transaction timeout',
        customerReference: '+919876543214',
        timestamp: '2026-09-04T08:00:00.000Z',
        rawPayload: { error_code: 'BAD_REQUEST_ERROR' }
      },
      {
        eventId: 'lab_evt_rec_01_captured',
        eventType: 'payment.captured',
        paymentId: 'lab_pay_rec_01',
        orderId: 'lab_order_rec_01',
        amount: 200000,
        currency: 'INR',
        paymentStatus: 'captured',
        customerReference: '+919876543214',
        timestamp: '2026-09-04T08:30:00.000Z',
        rawPayload: { status: 'captured' }
      }
    ],
    event: {
      eventId: 'lab_evt_rec_01_dupe_failed',
      eventType: 'payment.failed',
      paymentId: 'lab_pay_rec_01',
      orderId: 'lab_order_rec_01',
      amount: 200000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Late duplicate failure notification',
      customerReference: '+919876543214',
      timestamp: '2026-09-04T09:00:00.000Z',
      rawPayload: { status: 'failed' }
    }
  }
});

/**
 * Lists available demo scenarios with metadata.
 */
function listScenarios() {
  return Object.values(DEMO_SCENARIOS).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    sampleAmountPaise: s.event.amount,
    currency: s.event.currency
  }));
}

/**
 * Executes a scenario through the complete Revflow recovery decision machinery.
 *
 * @param {string} scenarioId
 * @param {object} [options]
 * @returns {Promise<object>} Detailed decision trace
 */
async function runScenario(scenarioId, options = {}) {
  const scenario = DEMO_SCENARIOS[scenarioId];
  if (!scenario) {
    throw new Error(`Unknown demo scenario '${scenarioId}'. Valid scenarios: ${Object.keys(DEMO_SCENARIOS).join(', ')}`);
  }

  // 1. Instantiate strictly EPHEMERAL in-memory repository
  const repository = new InMemoryRecoveryRepository();
  const now = options.now ? (() => new Date(options.now)) : (() => new Date(scenario.event.timestamp || Date.now()));

  // 2. Ingest prior events if any (e.g. for ALREADY_RECOVERED scenario)
  if (Array.isArray(scenario.priorEvents)) {
    for (const prior of scenario.priorEvents) {
      await processEvent(repository, prior);
    }
  }

  // 3. Process primary scenario event
  const eventResult = await processEvent(repository, scenario.event);
  const recoveryCase = eventResult.recoveryCase;

  // 4. Extract provider evidence & classify failure family
  const providerEvidence = extractProviderEvidence(scenario.event.rawPayload, scenario.event);
  const failureClassification = classifyFailureEvidence(providerEvidence);

  // 5. Evaluate candidate strategies using ERV framework
  const context = {
    amount: recoveryCase.amount,
    currency: recoveryCase.currency,
    riskLevel: recoveryCase.riskLevel,
    failureReason: recoveryCase.riskReason || scenario.event.failureReason,
    failureFamily: failureClassification.failureFamily,
    paymentAttemptCount: 1,
    timeSinceFailureMinutes: 0
  };

  const candidates = evaluateCandidates(context, scenario.category, failureClassification.failureFamily);
  const rankedCandidates = rankCandidates(candidates);
  const topCandidate = rankedCandidates[0] || null;

  // 6. Evaluate stopping criteria
  const detail = await repository.getCaseDetail(recoveryCase.id);
  const stoppingEvaluation = evaluateStoppingCriteria({
    recoveryCase: detail.recoveryCase,
    candidateAction: topCandidate?.action,
    events: detail.events,
    existingActions: detail.actions,
    now
  });

  // 7. Evaluate policy
  const diagnosis = {
    diagnosis: {
      cause: failureClassification.failureType,
      confidence: failureClassification.confidence,
      failureFamily: failureClassification.failureFamily,
      evidence: providerEvidence
    },
    proposedAction: topCandidate?.action,
    recommendation: {
      action: topCandidate?.action,
      reason: `Ranked #1 by ERV (₹${((topCandidate?.estimatedRecoveryValue || 0) / 100).toLocaleString('en-IN')})`
    }
  };

  const policyEvaluation = evaluatePolicy({
    recoveryCase: detail.recoveryCase,
    diagnosis,
    candidateAction: topCandidate?.action,
    events: detail.events,
    existingActions: detail.actions,
    allowSimulated: true,
    isTestMode: true,
    now
  });

  // 8. Execute selected action in ephemeral store if policy allows
  let executionResult = null;
  if (policyEvaluation.decision === 'ALLOW' && topCandidate) {
    try {
      if (topCandidate.action === 'SCHEDULE_RETRY_WINDOW') {
        executionResult = await executeSimulatedAction(repository, {
          recoveryCase: detail.recoveryCase,
          diagnosis,
          actionType: 'SCHEDULE_RETRY_WINDOW',
          events: detail.events,
          now
        });
      } else if (topCandidate.action === 'CREATE_PAYMENT_LINK') {
        executionResult = {
          executed: true,
          action: {
            actionType: 'CREATE_PAYMENT_LINK',
            status: 'EXECUTED',
            provider: 'simulated_lab',
            providerActionId: `lab_plink_${recoveryCase.id}`,
            amount: recoveryCase.amount,
            currency: recoveryCase.currency
          },
          message: 'Alternative payment link recovery action executed in lab environment.'
        };
        await repository.createAction({
          recoveryCaseId: recoveryCase.id,
          actionType: 'CREATE_PAYMENT_LINK',
          status: 'EXECUTED',
          policyDecision: 'ALLOW',
          policyVersion: policyEvaluation.policyVersion,
          idempotencyKey: `lab_plink_${recoveryCase.id}_v1`,
          provider: 'simulated_lab',
          providerActionId: `lab_plink_${recoveryCase.id}`,
          amount: recoveryCase.amount,
          currency: recoveryCase.currency,
          requestMetadata: { mode: 'lab_demonstration' }
        });
        await repository.addAudit(recoveryCase.id, 'ACTION_EXECUTED', 'Payment Link recovery executed in lab demonstration', {
          actionType: 'CREATE_PAYMENT_LINK',
          mode: 'lab'
        });
      }
    } catch (execErr) {
      executionResult = { executed: false, error: execErr.message };
    }
  }

  // 9. Fetch final case state & audit trail from ephemeral repository
  const finalDetail = await repository.getCaseDetail(recoveryCase.id);

  return {
    provenance: {
      mode: 'DEMO / SIMULATION',
      environment: 'EPHEMERAL_IN_MEMORY',
      productionMutation: false,
      liveFinancialAction: false
    },
    scenario: {
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      description: scenario.description
    },
    providerEvidence,
    failureClassification: {
      family: failureClassification.failureFamily,
      type: failureClassification.failureType,
      confidence: failureClassification.confidence,
      classificationBasis: failureClassification.classificationBasis,
      unknowns: failureClassification.unknowns
    },
    candidateStrategies: rankedCandidates.map((c) => {
      const def = getStrategy(c.action);
      return {
        action: c.action,
        name: def?.name || c.action,
        executionMode: c.executionMode,
        isLiveExecutable: c.isLiveExecutable,
        estimatedRecoveryValuePaise: c.estimatedRecoveryValue,
        estimatedRecoveryValueFormatted: `₹${(c.estimatedRecoveryValue / 100).toLocaleString('en-IN')}`,
        estimatedProbability: c.estimatedProbability,
        interventionCostPaise: c.interventionCost,
        estimatedFrictionPaise: c.estimatedFriction
      };
    }),
    selectedStrategy: topCandidate ? {
      action: topCandidate.action,
      name: getStrategy(topCandidate.action)?.name || topCandidate.action,
      executionMode: topCandidate.executionMode,
      ervPaise: topCandidate.estimatedRecoveryValue,
      ervFormatted: `₹${(topCandidate.estimatedRecoveryValue / 100).toLocaleString('en-IN')}`
    } : null,
    stoppingEvaluation: {
      stopped: stoppingEvaluation.stopped,
      actionDisposition: stoppingEvaluation.actionDisposition,
      reasonCode: stoppingEvaluation.reasonCode || null,
      humanReadableReason: stoppingEvaluation.humanReadableReason || null
    },
    policyEvaluation: {
      decision: policyEvaluation.decision,
      reasons: policyEvaluation.reasons,
      policyVersion: policyEvaluation.policyVersion,
      rulesPassed: policyEvaluation.rulesEvaluated.filter((r) => r.status === 'PASS').length,
      rulesBlocked: policyEvaluation.rulesEvaluated.filter((r) => r.status === 'BLOCK').length,
      rulesReview: policyEvaluation.rulesEvaluated.filter((r) => r.status === 'REVIEW').length
    },
    executionResult: {
      executed: executionResult?.executed || false,
      actionType: executionResult?.action?.actionType || null,
      actionStatus: executionResult?.action?.status || null,
      retrySchedule: executionResult?.action?.requestMetadata?.retrySchedule || null,
      caseAutonomyStatus: finalDetail.recoveryCase.autonomyStatus,
      nextRetryAt: finalDetail.recoveryCase.nextRetryAt || null
    },
    finalCaseState: {
      id: finalDetail.recoveryCase.id,
      riskStatus: finalDetail.recoveryCase.riskStatus,
      autonomyStatus: finalDetail.recoveryCase.autonomyStatus,
      nextRetryAt: finalDetail.recoveryCase.nextRetryAt || null,
      outcome: finalDetail.recoveryCase.outcome || null,
      recoveredAmountPaise: finalDetail.recoveryCase.recoveredAmount || 0
    },
    decisionTrace: finalDetail.auditEvents.map((a) => ({
      type: a.eventType,
      message: a.message,
      metadata: a.metadata,
      timestamp: a.createdAt
    }))
  };
}

module.exports = {
  DEMO_SCENARIOS,
  listScenarios,
  runScenario
};
