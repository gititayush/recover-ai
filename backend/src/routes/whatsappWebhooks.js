/**
 * Revflow V2 — WhatsApp Webhook Router
 *
 * Receives delivery receipts and status updates from the Twilio WhatsApp Sandbox.
 *
 * CRITICAL INVARIANT:
 * Status callbacks track message delivery only (QUEUED -> SENT -> DELIVERED -> READ).
 * Status callbacks NEVER mark cases RESOLVED or credit recovered revenue!
 */

const { Router } = require('express');
const { createCommunicationController } = require('../controllers/communicationController');

function createWhatsAppWebhookRouter(repository, whatsappProvider) {
  const router = Router();
  const controller = createCommunicationController(repository, whatsappProvider);

  router.post('/', controller.handleWebhook);

  return router;
}

module.exports = {
  createWhatsAppWebhookRouter
};
