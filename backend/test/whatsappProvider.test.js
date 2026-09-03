import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import {
  WhatsAppProvider,
  createWhatsAppProvider,
  formatWhatsAppDestination,
  normalizeProviderStatus,
  WhatsAppProviderError,
  ProviderConfigError,
  InvalidDestinationError,
  WHATSAPP_STATUSES
} from '../src/services/providers/whatsappProvider';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';
import { createApp } from '../src/app';

describe('Revflow V2 — Milestone 7: WhatsApp Provider & Status Webhook Integration', () => {
  // ==========================================
  // PROVIDER ADAPTER UNIT TESTS (Tests 1–11)
  // ==========================================
  describe('WhatsApp Provider Adapter Unit Tests', () => {
    it('1. formats valid Indian phone numbers to E.164 whatsapp: protocol format', () => {
      expect(formatWhatsAppDestination('+919876543210')).toBe('whatsapp:+919876543210');
      expect(formatWhatsAppDestination('9876543210')).toBe('whatsapp:+919876543210');
      expect(formatWhatsAppDestination('09876543210')).toBe('whatsapp:+919876543210');
      expect(formatWhatsAppDestination('whatsapp:+919876543210')).toBe('whatsapp:+919876543210');
    });

    it('2. throws InvalidDestinationError on malformed destination phone', () => {
      expect(() => formatWhatsAppDestination('12345')).toThrow(InvalidDestinationError);
      expect(() => formatWhatsAppDestination('')).toThrow(InvalidDestinationError);
      expect(() => formatWhatsAppDestination(null)).toThrow(InvalidDestinationError);
    });

    it('3. reports unconfigured when Twilio credentials are not set', () => {
      const provider = new WhatsAppProvider({ accountSid: null, authToken: null });
      expect(provider.isConfigured()).toBe(false);
      expect(provider.getProviderMode()).toBe('UNCONFIGURED');
    });

    it('4. throws ProviderConfigError when attempting to send with unconfigured credentials', async () => {
      const provider = new WhatsAppProvider({ accountSid: null, authToken: null });
      await expect(
        provider.sendMessage({
          to: '+919876543210',
          body: 'Test message'
        })
      ).rejects.toThrow(ProviderConfigError);
    });

    it('5. successfully sends via Twilio Messages API and parses MessageSid', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          sid: 'SM_test_valid_message_001',
          status: 'queued',
          to: 'whatsapp:+919876543210',
          from: 'whatsapp:+14155238886',
          date_created: new Date().toISOString()
        })
      });

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST_ACCOUNT_SID',
        authToken: 'AUTH_TEST_TOKEN',
        fromNumber: 'whatsapp:+14155238886',
        fetchFn: mockFetch
      });

      const result = await provider.sendMessage({
        to: '+919876543210',
        body: 'Hi Arjun, your payment of ₹750 is pending.'
      });

      expect(result.providerMessageId).toBe('SM_test_valid_message_001');
      expect(result.status).toBe(WHATSAPP_STATUSES.QUEUED);
      expect(mockFetch).toHaveBeenCalledOnce();

      // Verify Basic Auth headers
      const callArgs = mockFetch.mock.calls[0];
      const authHeader = callArgs[1].headers.Authorization;
      expect(authHeader).toMatch(/^Basic /);
    });

    it('6. normalizes HTTP 400 Bad Request error from Twilio', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          code: 21211,
          message: 'The \'To\' number is not a valid phone number.'
        })
      });

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST',
        authToken: 'AUTH_TEST',
        fetchFn: mockFetch
      });

      await expect(
        provider.sendMessage({ to: '+919876543210', body: 'Test' })
      ).rejects.toThrow(WhatsAppProviderError);
    });

    it('7. normalizes HTTP 429 Rate Limit error from Twilio', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          code: 20429,
          message: 'Too Many Requests: Rate limit exceeded.'
        })
      });

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST',
        authToken: 'AUTH_TEST',
        fetchFn: mockFetch
      });

      await expect(
        provider.sendMessage({ to: '+919876543210', body: 'Test' })
      ).rejects.toThrow(/Rate Limit Exceeded/i);
    });

    it('8. normalizes HTTP 500 Gateway/Server error from Twilio', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          message: 'Internal Server Error'
        })
      });

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST',
        authToken: 'AUTH_TEST',
        fetchFn: mockFetch
      });

      await expect(
        provider.sendMessage({ to: '+919876543210', body: 'Test' })
      ).rejects.toThrow(/Twilio Error \(500\)/);
    });

    it('9. normalizes fetch network timeout', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout after 10000ms'));

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST',
        authToken: 'AUTH_TEST',
        fetchFn: mockFetch
      });

      await expect(
        provider.sendMessage({ to: '+919876543210', body: 'Test' })
      ).rejects.toThrow(/Network timeout/);
    });

    it('10. catches missing or malformed message ID in 200 response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'queued' // Missing `sid`
        })
      });

      const provider = new WhatsAppProvider({
        accountSid: 'AC_TEST',
        authToken: 'AUTH_TEST',
        fetchFn: mockFetch
      });

      await expect(
        provider.sendMessage({ to: '+919876543210', body: 'Test' })
      ).rejects.toThrow(/missing required message SID/);
    });

    it('11. maps and normalizes raw provider status strings deterministically', () => {
      expect(normalizeProviderStatus('queued')).toBe(WHATSAPP_STATUSES.QUEUED);
      expect(normalizeProviderStatus('sending')).toBe(WHATSAPP_STATUSES.SENT);
      expect(normalizeProviderStatus('sent')).toBe(WHATSAPP_STATUSES.SENT);
      expect(normalizeProviderStatus('delivered')).toBe(WHATSAPP_STATUSES.DELIVERED);
      expect(normalizeProviderStatus('read')).toBe(WHATSAPP_STATUSES.READ);
      expect(normalizeProviderStatus('failed')).toBe(WHATSAPP_STATUSES.FAILED);
      expect(normalizeProviderStatus('undelivered')).toBe(WHATSAPP_STATUSES.UNDELIVERED);
      expect(normalizeProviderStatus('some_unknown_status')).toBe(WHATSAPP_STATUSES.UNKNOWN);
    });
  });

  // ==========================================
  // STATUS WEBHOOK INTEGRATION (Tests 12–21)
  // ==========================================
  describe('WhatsApp Status Webhook Handling', () => {
    let repository;
    let mockWhatsAppProvider;
    let app;

    beforeEach(async () => {
      repository = new InMemoryRecoveryRepository();

      mockWhatsAppProvider = {
        isConfigured: () => true,
        getProviderMode: () => 'TWILIO_SANDBOX',
        verifySignature: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          providerMessageId: 'SM_test_msg_999',
          status: 'QUEUED',
          rawResponse: { sid: 'SM_test_msg_999' }
        })
      };

      app = createApp(repository, { whatsappProvider: mockWhatsAppProvider });

      // Create a test recovery case and an executed communication action
      await repository.createCase({
        id: 1,
        paymentId: 'pay_webhook_test_01',
        amount: 75000,
        currency: 'INR',
        riskLevel: 'LOW',
        riskStatus: 'ACTIVE',
        riskReason: 'gateway timeout',
        customerReference: '+919876543210'
      });

      await repository.createAction({
        recoveryCaseId: 1,
        actionType: 'CUSTOMER_OUTREACH',
        status: 'EXECUTED',
        providerActionId: 'SM_test_msg_999',
        idempotencyKey: 'comm_1_SM_test_msg_999',
        requestMetadata: {
          strategy: 'CUSTOMER_OUTREACH',
          communication: {
            channel: 'whatsapp',
            language: 'hinglish',
            message: 'Hi Arjun, aapka ₹750 ka payment pending hai.',
            provider: 'twilio_sandbox',
            providerMessageId: 'SM_test_msg_999',
            status: 'QUEUED',
            provenance: 'WHATSAPP_TEST_PROVIDER'
          }
        },
        responseMetadata: {
          lastProviderStatus: 'QUEUED'
        }
      });
    });

    it('12. processes valid DELIVERED status callback and updates action metadata', async () => {
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({
          MessageSid: 'SM_test_msg_999',
          MessageStatus: 'delivered',
          To: 'whatsapp:+919876543210'
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe('DELIVERED');

      // Verify action updated in repository
      const action = await repository.findActionByProviderActionId('SM_test_msg_999');
      expect(action.requestMetadata.communication.status).toBe('DELIVERED');
      expect(action.responseMetadata.lastProviderStatus).toBe('DELIVERED');
    });

    it('13. processes READ status callback progressing beyond DELIVERED', async () => {
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({
          MessageSid: 'SM_test_msg_999',
          MessageStatus: 'read',
          To: 'whatsapp:+919876543210'
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('READ');

      const action = await repository.findActionByProviderActionId('SM_test_msg_999');
      expect(action.requestMetadata.communication.status).toBe('READ');
    });

    it('14. drops out-of-order status callbacks (e.g., DELIVERED arriving after READ)', async () => {
      // Set action status to READ first
      const action = await repository.findActionByProviderActionId('SM_test_msg_999');
      action.requestMetadata.communication.status = 'READ';
      action.responseMetadata.lastProviderStatus = 'READ';
      await repository.updateAction(action.id, action);

      // Incoming delayed 'delivered' callback
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({
          MessageSid: 'SM_test_msg_999',
          MessageStatus: 'delivered',
          To: 'whatsapp:+919876543210'
        });

      expect(res.status).toBe(200);
      expect(res.body.droppedReason).toBe('OUT_OF_ORDER');

      // Assert status remains READ
      const refreshed = await repository.findActionByProviderActionId('SM_test_msg_999');
      expect(refreshed.requestMetadata.communication.status).toBe('READ');
    });

    it('15. deduplicates replay webhook callbacks idempotently', async () => {
      // First webhook
      await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({ MessageSid: 'SM_test_msg_999', MessageStatus: 'delivered' });

      // Duplicate replay of exact same status
      const replayRes = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({ MessageSid: 'SM_test_msg_999', MessageStatus: 'delivered' });

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.duplicate).toBe(true);
    });

    it('16. safely handles status callback for unknown MessageSid without crashing', async () => {
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({
          MessageSid: 'SM_UNKNOWN_NEVER_EXISTED',
          MessageStatus: 'delivered'
        });

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(false);
      expect(res.body.warning).toContain('No matching recovery action');
    });

    it('17. processes FAILED status callback and marks action FAILED', async () => {
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({
          MessageSid: 'SM_test_msg_999',
          MessageStatus: 'failed',
          ErrorCode: '30008',
          ErrorMessage: 'Unknown destination'
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FAILED');

      const action = await repository.findActionByProviderActionId('SM_test_msg_999');
      expect(action.status).toBe('FAILED');
    });

    it('18. CRITICAL INVARIANT: WhatsApp status callback NEVER marks case RESOLVED or credits revenue', async () => {
      // Deliver and Read the message
      await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({ MessageSid: 'SM_test_msg_999', MessageStatus: 'delivered' });

      await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({ MessageSid: 'SM_test_msg_999', MessageStatus: 'read' });

      // Check recovery case
      const detail = await repository.getCaseDetail(1);
      expect(detail.recoveryCase.riskStatus).toBe('ACTIVE');
      expect(detail.recoveryCase.outcome).toBeNull();
      expect(detail.recoveryCase.recoveredAmount).toBe(0);

      // Verify zero outcomes recorded
      const outcomes = await repository.findOutcomesByCaseId(1);
      expect(outcomes.length).toBe(0);
    });

    it('19. rejects webhook when Twilio signature verification fails', async () => {
      const rejectProvider = {
        ...mockWhatsAppProvider,
        verifySignature: () => false
      };
      const rejectApp = createApp(repository, { whatsappProvider: rejectProvider });

      const res = await request(rejectApp)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .set('x-twilio-signature', 'invalid_signature_header_val')
        .send({ MessageSid: 'SM_test_msg_999', MessageStatus: 'delivered' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('INVALID_SIGNATURE');
    });

    it('20. rejects webhook payload missing MessageSid', async () => {
      const res = await request(app)
        .post('/api/webhooks/whatsapp')
        .type('form')
        .send({ MessageStatus: 'delivered' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MISSING_MESSAGE_SID');
    });

    it('21. preview endpoint exposes providerConfigured: false when Twilio is unconfigured', async () => {
      const unconfiguredProvider = createWhatsAppProvider({ accountSid: null, authToken: null });
      const unconfiguredApp = createApp(repository, { whatsappProvider: unconfiguredProvider });

      const res = await request(unconfiguredApp)
        .post('/api/cases/1/communication/preview')
        .send({ channel: 'whatsapp', language: 'hinglish' });

      expect(res.status).toBe(200);
      expect(res.body.providerConfigured).toBe(false);
      expect(res.body.providerMode).toBe('UNCONFIGURED');
    });
  });
});
