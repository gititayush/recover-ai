/**
 * Revflow V2 — Batch Routes
 */

const { Router } = require('express');
const { handleEvaluateBatch } = require('../controllers/batchController');

function createBatchRouter() {
  const router = Router();
  router.post('/evaluate', handleEvaluateBatch);
  return router;
}

module.exports = {
  createBatchRouter
};
