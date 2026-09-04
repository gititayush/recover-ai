/**
 * Revflow — Recovery Lab Routes
 */

const { Router } = require('express');
const { createRecoveryLabController } = require('../controllers/recoveryLabController');

function createRecoveryLabRouter() {
  const router = Router();
  const controller = createRecoveryLabController();

  router.get('/scenarios', controller.listScenarios);
  router.post('/run-scenario', controller.runScenario);

  return router;
}

module.exports = {
  createRecoveryLabRouter
};
