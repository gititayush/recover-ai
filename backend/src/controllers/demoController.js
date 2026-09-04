/**
 * Revflow — Demo Recovery Portfolio Controller
 *
 * Exposes isolated demonstration endpoints for the 8-case Demo Recovery Portfolio.
 * Strictly partitioned to is_demo = true.
 */

const { getStrategy } = require('../strategies/strategyRegistry');
const { evaluatePolicy } = require('../policy/policyEngine');
const { evaluateStoppingCriteria } = require('../policy/stoppingEngine');
const { DEMO_FIXTURES, seedDemoPortfolio } = require('../db/seedDemoPortfolio');

function createDemoController(repository, { diagnosisService } = {}) {
  return {
    listCases: async (request, response, next) => {
      try {
        const cases = await repository.listCases({ isDemo: true });
        const augmented = await Promise.all(cases.map(async (caseItem) => {
          const detail = await repository.getCaseDetail(caseItem.id);
          const diagnosis = await repository.findDiagnosisByCaseId(caseItem.id);
          const events = detail?.events || [];
          const actions = detail?.actions || [];

          const recommendedAction = diagnosis?.recommendation?.action
            || diagnosis?.proposedAction
            || 'CREATE_PAYMENT_LINK';

          const strategy = getStrategy(recommendedAction);
          const executionMode = strategy?.executionMode || 'CONTROL';

          const policyResult = evaluatePolicy({
            recoveryCase: caseItem,
            diagnosis,
            candidateAction: recommendedAction,
            events,
            existingActions: actions,
            allowSimulated: true
          });

          const stoppingResult = evaluateStoppingCriteria({
            recoveryCase: caseItem,
            diagnosis,
            candidateAction: recommendedAction,
            events,
            existingActions: actions
          });

          const fixture = DEMO_FIXTURES.find((f) => f.event.paymentId === caseItem.paymentId);
          const candidates = diagnosis?.candidates || [];
          const selectedCandidate = candidates.find((c) => c.action === recommendedAction) || candidates[0];
          const erv = selectedCandidate?.estimatedRecoveryValue || Math.round(caseItem.amount * 0.35);

          return {
            ...caseItem,
            isDemo: true,
            scenarioName: fixture?.name || caseItem.riskReason,
            scenarioKey: fixture?.scenarioKey || null,
            expectedRecoveryValue: erv,
            estimatedProbability: selectedCandidate?.estimatedProbability || null,
            candidates,
            failureFamily: diagnosis?.diagnosis?.failureFamily || 'UNKNOWN_FAILURE',
            failureType: diagnosis?.diagnosis?.failureType || null,
            recommendedStrategy: recommendedAction,
            strategyName: strategy?.name || recommendedAction,
            executionMode,
            isLiveExecutable: Boolean(strategy?.isLiveExecutable),
            policyDecision: policyResult.decision,
            policyReasons: (policyResult.blockReasons || []).concat(policyResult.reviewReasons || []),
            stoppingDisposition: stoppingResult.actionDisposition,
            stoppingReason: stoppingResult.humanReadableReason || null,
            diagnosis: diagnosis ? {
              category: diagnosis.diagnosis?.category,
              failureFamily: diagnosis.diagnosis?.failureFamily,
              failureType: diagnosis.diagnosis?.failureType,
              cause: diagnosis.diagnosis?.cause,
              confidence: diagnosis.diagnosis?.confidence,
              evidence: diagnosis.diagnosis?.evidence,
              unknowns: diagnosis.diagnosis?.unknowns
            } : null,
            actionsCount: actions.length,
            activePaymentLink: actions.find((a) => a.actionType === 'CREATE_PAYMENT_LINK' && (a.paymentLinkUrl || a.actionPayload?.payment_link_url)) || null
          };
        }));

        return response.status(200).json({
          provenance: 'DEMO / RAZORPAY TEST MODE',
          isDemo: true,
          liveFinancialAction: false,
          totalCases: augmented.length,
          cases: augmented
        });
      } catch (error) {
        return next(error);
      }
    },

    getCaseById: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail || !detail.recoveryCase || !detail.recoveryCase.isDemo) {
          return response.status(404).json({
            error: 'DEMO_CASE_NOT_FOUND',
            message: 'Demo recovery case not found in demo partition.'
          });
        }

        const diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);
        const recommendedAction = diagnosis?.recommendation?.action
          || diagnosis?.proposedAction
          || 'CREATE_PAYMENT_LINK';
        const strategy = getStrategy(recommendedAction);

        const policyResult = evaluatePolicy({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: recommendedAction,
          events: detail.events || [],
          existingActions: detail.actions || [],
          allowSimulated: true
        });

        const stoppingResult = evaluateStoppingCriteria({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: recommendedAction,
          events: detail.events || [],
          existingActions: detail.actions || []
        });

        const fixture = DEMO_FIXTURES.find((f) => f.event.paymentId === detail.recoveryCase.paymentId);
        const candidates = diagnosis?.candidates || [];
        const selectedCandidate = candidates.find((c) => c.action === recommendedAction) || candidates[0];
        const erv = selectedCandidate?.estimatedRecoveryValue || Math.round(detail.recoveryCase.amount * 0.35);

        return response.status(200).json({
          ...detail,
          isDemo: true,
          scenarioName: fixture?.name || detail.recoveryCase.riskReason,
          scenarioKey: fixture?.scenarioKey || null,
          expectedRecoveryValue: erv,
          estimatedProbability: selectedCandidate?.estimatedProbability || null,
          candidates,
          diagnosis,
          strategy,
          policyEvaluation: policyResult,
          stoppingEvaluation: stoppingResult
        });
      } catch (error) {
        return next(error);
      }
    },

    getMetrics: async (request, response, next) => {
      try {
        const metrics = await repository.getRecoveryMetrics({ isDemo: true });
        return response.status(200).json({
          provenance: 'DEMO / RAZORPAY TEST MODE',
          isDemo: true,
          liveFinancialAction: false,
          metrics
        });
      } catch (error) {
        return next(error);
      }
    },

    seed: async (request, response, next) => {
      try {
        const result = await seedDemoPortfolio(repository, { diagnosisService });
        return response.status(200).json({
          success: true,
          message: 'Demo recovery portfolio seeded successfully.',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = {
  createDemoController
};
