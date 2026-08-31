const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createEventRouter } = require('./routes/events');
const { createCaseRouter } = require('./routes/cases');
const { createRazorpayWebhookRouter } = require('./routes/razorpayWebhooks');
const { createDiagnosisService } = require('./ai/diagnosisService');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp(repository, { diagnosisService = createDiagnosisService() } = {}) {
  const app = express();
  app.use(cors());
  app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '100kb' }), createRazorpayWebhookRouter(repository));
  app.use(express.json({ limit: '100kb' }));
  app.use(morgan('tiny'));
  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  app.use('/api/events', createEventRouter(repository));
  app.use('/api/cases', createCaseRouter(repository, diagnosisService));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
