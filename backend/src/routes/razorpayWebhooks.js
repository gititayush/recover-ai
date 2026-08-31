const express = require('express');
const { createRazorpayWebhookController } = require('../controllers/razorpayWebhookController');

function createRazorpayWebhookRouter(repository) {
  const router = express.Router();
  router.post('/', createRazorpayWebhookController(repository));
  return router;
}

module.exports = { createRazorpayWebhookRouter };
