const express = require('express');
const { createCaseController } = require('../controllers/caseController');

function createCaseRouter(repository, diagnosisService) {
  const router = express.Router();
  const controller = createCaseController(repository, diagnosisService);
  router.get('/', controller.list);
  router.get('/:id/diagnosis', controller.getDiagnosis);
  router.post('/:id/diagnosis', controller.generateDiagnosis);
  router.get('/:id', controller.getById);
  return router;
}

module.exports = { createCaseRouter };
