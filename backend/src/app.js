const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createEventRouter } = require('./routes/events');
const { createCaseRouter } = require('./routes/cases');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp(repository) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(morgan('tiny'));
  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  app.use('/api/events', createEventRouter(repository));
  app.use('/api/cases', createCaseRouter(repository));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
