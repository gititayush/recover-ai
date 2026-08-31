const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createEventRouter } = require('./routes/events');
const { createCaseRouter } = require('./routes/cases');
const { createRazorpayWebhookRouter } = require('./routes/razorpayWebhooks');
const { createDiagnosisService } = require('./ai/diagnosisService');
const { createRazorpayClient } = require('./services/razorpayClient');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp(repository, { diagnosisService = createDiagnosisService(), razorpayClient = createRazorpayClient() } = {}) {
  const app = express();
  app.use(cors());
  app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '100kb' }), createRazorpayWebhookRouter(repository));
  app.use(express.json({ limit: '100kb' }));
  app.use(morgan('tiny'));
  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  app.get('/api/recovery/metrics', async (request, response, next) => {
    try { response.json({ metrics: await repository.getRecoveryMetrics() }); } catch (error) { next(error); }
  });
  app.get('/api/recovery/playbooks', (request, response) => {
    const { getAllPlaybooks } = require('./playbooks/playbookDefinitions');
    response.json({ playbooks: getAllPlaybooks() });
  });
  app.get('/api/recovery/evaluation', (request, response) => {
    const fs = require('fs');
    const path = require('path');
    const summaryPath = path.join(__dirname, '..', '..', 'evaluation', 'results', 'evaluation_summary.json');
    if (fs.existsSync(summaryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        return response.json(data);
      } catch (err) {
        return response.status(500).json({ error: 'EVALUATION_READ_ERROR', message: 'Failed to read evaluation summary.' });
      }
    }
    return response.status(404).json({ error: 'EVALUATION_NOT_FOUND', message: 'Evaluation summary not generated yet. Run pnpm evaluate.' });
  });
  app.use('/api/events', createEventRouter(repository));
  app.use('/api/cases', createCaseRouter(repository, diagnosisService, razorpayClient));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
