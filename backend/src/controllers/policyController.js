const { evaluatePolicy } = require('../policy/policyEngine');
const { executePaymentLink, RecoveryExecutorError } = require('../actions/paymentLinkExecutor');
const { executeSimulatedAction, SimulatedActionExecutorError } = require('../actions/simulatedActionExecutor');
const { getStrategy, EXECUTION_MODES } = require('../strategies/strategyRegistry');
const { createRazorpayClient } = require('../services/razorpayClient');

function createPolicyController(repository, diagnosisService, razorpayClient = createRazorpayClient()) {
  return {
    evaluate: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });

        let diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);
        if (!diagnosis) {
          const decision = await diagnosisService.diagnose(detail);
          diagnosis = await repository.createDiagnosis({ recoveryCaseId: detail.recoveryCase.id, ...decision });
        }

        const existingActions = await repository.findActionsByCaseId(detail.recoveryCase.id);
        const policyDecision = evaluatePolicy({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: request.body?.action || (['REQUEST_MANUAL_REVIEW', 'NO_ACTION', 'CREATE_PAYMENT_LINK'].includes(diagnosis?.recommendation?.action) ? diagnosis.recommendation.action : 'CREATE_PAYMENT_LINK'),
          events: detail.events,
          existingActions,
          isTestMode: razorpayClient.isTestMode !== undefined ? razorpayClient.isTestMode : false
        });

        await repository.addAudit(detail.recoveryCase.id, 'POLICY_EVALUATED', `Policy evaluated: ${policyDecision.decision}`, {
          decision: policyDecision.decision,
          action: policyDecision.action,
          reasons: policyDecision.reasons,
          policyVersion: policyDecision.policyVersion
        });

        return response.json({
          policy: policyDecision,
          diagnosis,
          actions: existingActions
        });
      } catch (error) {
        return next(error);
      }
    },

    execute: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });

        let diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);
        if (!diagnosis) {
          const decision = await diagnosisService.diagnose(detail);
          diagnosis = await repository.createDiagnosis({ recoveryCaseId: detail.recoveryCase.id, ...decision });
        }

        const targetAction = request.body?.action || diagnosis?.recommendation?.action || diagnosis?.proposedAction || 'CREATE_PAYMENT_LINK';
        const strategy = getStrategy(targetAction);

        let result;
        if (targetAction === 'CREATE_PAYMENT_LINK') {
          result = await executePaymentLink(repository, {
            recoveryCase: detail.recoveryCase,
            diagnosis,
            events: detail.events,
            razorpayClient
          });
        } else if (strategy && strategy.executionMode === EXECUTION_MODES.SIMULATED) {
          result = await executeSimulatedAction(repository, {
            recoveryCase: detail.recoveryCase,
            diagnosis,
            actionType: targetAction,
            events: detail.events
          });
        } else {
          return response.status(422).json({
            error: 'EXECUTION_REJECTED',
            message: `Action '${targetAction}' is a ${strategy?.executionMode || 'CONTROL'} action and cannot be directly executed.`
          });
        }

        return response.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) {
        if (error instanceof RecoveryExecutorError || error instanceof SimulatedActionExecutorError) {
          return response.status(error.statusCode || 422).json({
            error: 'EXECUTION_REJECTED',
            message: error.message,
            details: error.details
          });
        }
        return next(error);
      }
    },

    listActions: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        const actions = await repository.findActionsByCaseId(detail.recoveryCase.id);
        return response.json({ actions });
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = { createPolicyController };
