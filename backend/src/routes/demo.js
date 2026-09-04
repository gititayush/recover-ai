/**
 * Revflow — Demo Recovery Portfolio Routes
 *
 * Dedicated endpoints:
 * GET /api/demo/cases
 * GET /api/demo/cases/:id
 * GET /api/demo/metrics
 * POST /api/demo/seed
 */

const express = require('express');
const { createDemoController } = require('../controllers/demoController');

function createDemoRouter(repository, dependencies = {}) {
  const router = express.Router();
  const controller = createDemoController(repository, dependencies);

  router.get('/cases', controller.listCases);
  router.get('/cases/:id', controller.getCaseById);
  router.get('/metrics', controller.getMetrics);
  router.post('/seed', controller.seed);

  return router;
}

module.exports = {
  createDemoRouter
};
