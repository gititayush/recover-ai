const { ZodError } = require('zod');
const logger = require('../config/logger');

function notFoundHandler(request, response) {
  response.status(404).json({ error: 'NOT_FOUND', message: `Route ${request.method} ${request.originalUrl} was not found.` });
}

function errorHandler(error, request, response, next) {
  if (error instanceof ZodError) return response.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid event payload.', details: error.issues });
  logger.error('Unhandled request error', { method: request.method, path: request.originalUrl, error: error.message });
  return response.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' });
}

module.exports = { notFoundHandler, errorHandler };
