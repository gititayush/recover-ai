/**
 * Revflow V2 — Batch Evaluation Controller
 */

const { evaluateBatch, BatchValidationError } = require('../services/batchRecoveryService');

async function handleEvaluateBatch(request, response, next) {
  try {
    const { cases, simulateRecoveries = false, options = {} } = request.body || {};

    if (!cases) {
      return response.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Request body must include a "cases" array.'
      });
    }

    const evaluation = evaluateBatch(cases, {
      simulateRecoveries: Boolean(simulateRecoveries),
      maxBatchSize: options.maxBatchSize,
      isTestMode: true
    });

    return response.status(200).json(evaluation);
  } catch (error) {
    if (error instanceof BatchValidationError) {
      return response.status(error.statusCode).json({
        error: error.name,
        message: error.message,
        details: error.details
      });
    }
    return next(error);
  }
}

module.exports = {
  handleEvaluateBatch
};
