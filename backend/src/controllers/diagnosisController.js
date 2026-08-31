const { AiDiagnosisValidationError } = require('../ai/diagnosisSchema');
const { AiProviderError } = require('../ai/providerAdapter');

function createDiagnosisController(repository, diagnosisService) {
  return {
    generate: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });

        const existing = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);
        if (existing) return response.json({ diagnosis: existing, cached: true });

        const decision = await diagnosisService.diagnose(detail);
        const persisted = await repository.withTransaction(async (transaction) => {
          const concurrentDecision = await transaction.findDiagnosisByCaseId(detail.recoveryCase.id);
          if (concurrentDecision) return { diagnosis: concurrentDecision, cached: true };
          const diagnosis = await transaction.createDiagnosis({ recoveryCaseId: detail.recoveryCase.id, ...decision });
          await transaction.addAudit(detail.recoveryCase.id, 'AI_DIAGNOSIS', `AI diagnosis accepted: ${diagnosis.recommendation.action}`, {
            cause: diagnosis.diagnosis.cause,
            confidence: diagnosis.diagnosis.confidence,
            proposedAction: diagnosis.proposedAction,
            recommendedAction: diagnosis.recommendation.action,
            promptVersion: diagnosis.promptVersion,
            provider: diagnosis.provider,
            model: diagnosis.model,
            source: diagnosis.source
          });
          return { diagnosis, cached: false };
        });
        return response.status(persisted.cached ? 200 : 201).json(persisted);
      } catch (error) {
        if (error instanceof AiDiagnosisValidationError) return response.status(422).json({ error: 'AI_DIAGNOSIS_INVALID', message: error.message });
        if (error instanceof AiProviderError) return response.status(502).json({ error: 'AI_PROVIDER_UNAVAILABLE', message: 'AI diagnosis provider is unavailable.' });
        return next(error);
      }
    },
    get: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        const diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);
        if (!diagnosis) return response.status(404).json({ error: 'DIAGNOSIS_NOT_FOUND', message: 'No diagnosis has been generated for this recovery case.' });
        return response.json({ diagnosis, cached: true });
      } catch (error) { return next(error); }
    }
  };
}

module.exports = { createDiagnosisController };
