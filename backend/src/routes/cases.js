const express = require('express');
const { createCaseController } = require('../controllers/caseController');

function createCaseRouter(repository, diagnosisService, razorpayClient) {
  const router = express.Router();
  const controller = createCaseController(repository, diagnosisService, razorpayClient);
  router.get('/metrics', controller.getMetrics);
  router.get('/escalations', controller.listEscalations);
  router.get('/', controller.list);
  router.get('/:id/diagnosis', controller.getDiagnosis);
  router.post('/:id/diagnosis', controller.generateDiagnosis);
  router.post('/:id/policy', controller.evaluatePolicy);
  router.post('/:id/escalations/approve', controller.approveEscalation);
  router.post('/:id/escalations/reject', controller.rejectEscalation);
  router.post('/:id/recovery-actions', controller.executeAction);
  router.get('/:id/recovery-actions', controller.listActions);
  router.get('/:id/recovery-outcome', controller.getRecoveryOutcome);
  router.get('/:id', controller.getById);
  return router;
}

module.exports = { createCaseRouter };
