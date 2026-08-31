const { evaluatePolicy } = require('../policy/policyEngine');
const { executePaymentLink, RecoveryExecutorError } = require('../actions/paymentLinkExecutor');
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
          candidateAction: request.body?.action || null,
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

        const result = await executePaymentLink(repository, {
          recoveryCase: detail.recoveryCase,
          diagnosis,
          events: detail.events,
          razorpayClient
        });

        return response.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) {
        if (error instanceof RecoveryExecutorError) {
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
