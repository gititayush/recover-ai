const express = require('express');
const { createEventController } = require('../controllers/eventController');

function createEventRouter(repository) {
  const router = express.Router();
  router.post('/', createEventController(repository));
  return router;
}

module.exports = { createEventRouter };
