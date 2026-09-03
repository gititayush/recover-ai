/**
 * Revflow V2 — Analytics Routes
 */

const { Router } = require('express');
const { createAnalyticsController } = require('../controllers/analyticsController');

function createAnalyticsRouter(repository) {
  const router = Router();
  const controller = createAnalyticsController(repository);

  router.get('/', controller.handleGetAnalytics);
  router.get('/strategies', controller.handleGetStrategyAnalytics);
  router.get('/failures', controller.handleGetFailureAnalytics);
  router.get('/velocity', controller.handleGetVelocityAnalytics);

  return router;
}

module.exports = {
  createAnalyticsRouter
};
