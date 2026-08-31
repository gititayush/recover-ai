function createCaseController(repository, diagnosisService, razorpayClient) {
  const { createDiagnosisController } = require('./diagnosisController');
  const { createPolicyController } = require('./policyController');
  const diagnosisController = createDiagnosisController(repository, diagnosisService);
  const policyController = createPolicyController(repository, diagnosisService, razorpayClient);
  return {
    list: async (request, response, next) => {
      try { response.json({ cases: await repository.listCases() }); } catch (error) { next(error); }
    },
    getMetrics: async (request, response, next) => {
      try {
        const metrics = await repository.getRecoveryMetrics();
        return response.json({ metrics });
      } catch (error) { return next(error); }
    },
    getById: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        return response.json(detail);
      } catch (error) { return next(error); }
    },
    getRecoveryOutcome: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        const outcomes = await repository.findOutcomesByCaseId(detail.recoveryCase.id);
        return response.json({ outcomes, recoveryCase: detail.recoveryCase });
      } catch (error) { return next(error); }
    },
    generateDiagnosis: diagnosisController.generate,
    getDiagnosis: diagnosisController.get,
    evaluatePolicy: policyController.evaluate,
    executeAction: policyController.execute,
    listActions: policyController.listActions
  };
}

module.exports = { createCaseController };
