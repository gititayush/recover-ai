import { describe, it, expect, beforeEach, vi } from 'vitest';
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { processEvent } = require('../src/services/eventService');
const { createRecoveryWorker } = require('../src/worker/recoveryWorker');
const { environment } = require('../src/config/env');
const { createWhatsAppProvider } = require('../src/services/providers/whatsappProvider');

function createMockDiagnosisService(overrides = {}) {
  return {
    diagnose: vi.fn().mockResolvedValue({
      diagnosis: {
        cause: 'Customer bank gateway timeout during 3DS challenge.',
        confidence: 0.88,
        evidence: [{ field: 'payment.failureReason', value: 'gateway_timeout' }]
      },
      proposedAction: 'CREATE_PAYMENT_LINK',
      recommendation: {
        action: 'CREATE_PAYMENT_LINK',
        reason: 'Payment Link has highest probability of recovering temporary bank outage.'
      },
      candidates: [{ action: 'CREATE_PAYMENT_LINK', score: 0.9 }],
      provider: 'test-ai',
      model: 'test-model',
      promptVersion: 'v1',
      source: 'live_ai',
      ...overrides
    })
  };
}

function createMockRazorpayClient() {
  const existingLinks = new Map();
  return {
    isConfigured: true,
    isTestMode: true,
    keyId: 'rzp_test_mock123',
    createPaymentLink: vi.fn().mockImplementation(async (payload) => {
      const ref = payload.referenceId;
      const link = {
        id: `plink_test_${Math.random().toString(36).substring(2, 9)}`,
        short_url: `https://rzp.io/i/test_${Math.random().toString(36).substring(2, 7)}`,
        status: 'created',
        amount: payload.amount,
        currency: payload.currency,
        reference_id: ref
      };
      existingLinks.set(ref, link);
      return link;
    }),
    getPaymentLinksByReferenceId: vi.fn().mockImplementation(async (referenceId) => {
      if (existingLinks.has(referenceId)) {
        return [existingLinks.get(referenceId)];
      }
      return [];
    })
  };
}

const baseFailedEvent = {
  eventId: 'evt_test_autonomy_wa_1',
  eventType: 'payment.failed',
  paymentId: 'pay_test_autonomy_wa_1',
  orderId: 'order_test_autonomy_wa_1',
  amount: 499900,
  currency: 'INR',
  paymentStatus: 'failed',
  failureReason: 'gateway_timeout',
  customerReference: '+919876543210',
  rawPayload: {
    customerName: 'Aarav Sharma',
    customerPhone: '+919876543210'
  },
  timestamp: '2026-09-01T10:00:00.000Z'
};

describe('Milestone 7 — Autonomous WhatsApp Outreach Bridge', () => {
  let repository;
  let mockRazorpay;
  let mockDiagnosis;

  beforeEach(() => {
    repository = new InMemoryRecoveryRepository();
    mockRazorpay = createMockRazorpayClient();
    mockDiagnosis = createMockDiagnosisService();
    environment.AUTONOMOUS_RECOVERY_ENABLED = true;
    environment.AUTONOMOUS_WHATSAPP_ENABLED = false;
  });

  it('1. Feature Flag OFF: creates payment link but skips WhatsApp dispatch', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = false;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn()
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    expect(eventResult.recoveryCase.autonomyStatus).toBe('QUEUED');

    const runResult = await worker.pollOnce();
    expect(runResult.processed).toBe(true);
    expect(runResult.status).toBe('COMPLETED');
    expect(runResult.action).toBeDefined();
    expect(runResult.action.actionType).toBe('CREATE_PAYMENT_LINK');
    expect(runResult.outreachAction).toBeNull();

    // WhatsApp provider must NOT be contacted
    expect(mockWhatsAppProvider.sendMessage).not.toHaveBeenCalled();

    // No CUSTOMER_OUTREACH action created
    const actions = await repository.findActionsByCaseId(eventResult.recoveryCase.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].actionType).toBe('CREATE_PAYMENT_LINK');

    // Autonomy completed audit recorded
    const detail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const completedAudit = detail.auditEvents.find((a) => a.eventType === 'AUTONOMY_COMPLETED');
    expect(completedAudit).toBeDefined();
    expect(completedAudit.metadata.autonomousOutreach.attempted).toBe(false);
  });

  it('2. Feature Flag ON: dispatches grounded WhatsApp message via Sandbox provider', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'SM_sandbox_test_123',
        status: 'QUEUED',
        provider: 'twilio_sandbox'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    const runResult = await worker.pollOnce();

    expect(runResult.processed).toBe(true);
    expect(runResult.status).toBe('COMPLETED');
    expect(runResult.action.actionType).toBe('CREATE_PAYMENT_LINK');
    expect(runResult.outreachAction).toBeDefined();
    expect(runResult.outreachAction.actionType).toBe('CUSTOMER_OUTREACH');
    expect(runResult.outreachAction.status).toBe('EXECUTED');
    expect(runResult.outreachAction.providerActionId).toBe('SM_sandbox_test_123');

    // Provider called with grounded parameters
    expect(mockWhatsAppProvider.sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = mockWhatsAppProvider.sendMessage.mock.calls[0][0];
    expect(sendCall.to).toBe('+919876543210');
    expect(sendCall.message).toContain('₹4,999');
    expect(sendCall.message).toContain('Aarav Sharma');
    expect(sendCall.message).toContain('https://rzp.io/i/');

    // Database actions inspection
    const actions = await repository.findActionsByCaseId(eventResult.recoveryCase.id);
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.actionType)).toEqual(['CREATE_PAYMENT_LINK', 'CUSTOMER_OUTREACH']);

    // Audit trail inspection
    const detail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const commAudit = detail.auditEvents.find((a) => a.eventType === 'COMMUNICATION_DISPATCHED');
    expect(commAudit).toBeDefined();
    expect(commAudit.metadata.provenance).toBe('WHATSAPP_TEST_PROVIDER');
    expect(commAudit.metadata.isAutonomous).toBe(true);
  });

  it('3. Feature Flag ON with Twilio unconfigured: executes bounded SIMULATION', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const unconfiguredProvider = createWhatsAppProvider({ accountSid: null, authToken: null });

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: unconfiguredProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    const runResult = await worker.pollOnce();

    expect(runResult.processed).toBe(true);
    expect(runResult.status).toBe('COMPLETED');
    expect(runResult.outreachAction).toBeDefined();
    expect(runResult.outreachAction.status).toBe('EXECUTED');
    expect(runResult.outreachAction.provider).toBe('simulated');
    expect(runResult.outreachAction.providerActionId).toMatch(/^sim_msg_/);
    expect(runResult.outreachAction.requestMetadata.communication.provenance).toBe('SIMULATED');

    const detail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const commAudit = detail.auditEvents.find((a) => a.eventType === 'COMMUNICATION_DISPATCHED');
    expect(commAudit).toBeDefined();
    expect(commAudit.metadata.provenance).toBe('SIMULATED');
  });

  it('4. Provider failure after link creation: preserves financial action and marks outreach FAILED', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const failingProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn().mockRejectedValue(
        new Error('Twilio Bad Request (code 63015): Channel Sandbox: Recipient phone number has not joined this sandbox')
      )
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: failingProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    const runResult = await worker.pollOnce();

    // The autonomy job itself completes safely and does not crash or roll back
    expect(runResult.processed).toBe(true);
    expect(runResult.status).toBe('COMPLETED');

    // Payment Link action remains EXECUTED and valid
    expect(runResult.action.actionType).toBe('CREATE_PAYMENT_LINK');
    expect(runResult.action.status).toBe('EXECUTED');
    expect(runResult.action.paymentLinkUrl).toBeDefined();

    // Outreach action is persisted as FAILED
    expect(runResult.outreachAction).toBeDefined();
    expect(runResult.outreachAction.actionType).toBe('CUSTOMER_OUTREACH');
    expect(runResult.outreachAction.status).toBe('FAILED');
    expect(runResult.outreachAction.responseMetadata.error).toContain('Channel Sandbox');

    // Case state is still RECOVERABLE (not failed or blocked)
    const freshDetail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const freshCase = freshDetail.recoveryCase;
    expect(freshCase.riskStatus).toBe('RECOVERABLE');
    expect(freshCase.outcome).toBeNull();

    // Audit logs communication failure
    const detail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const failAudit = detail.auditEvents.find((a) => a.eventType === 'COMMUNICATION_FAILED');
    expect(failAudit).toBeDefined();
    expect(failAudit.metadata.error).toContain('Channel Sandbox');
  });

  it('5. Duplicate / lease re-drive protection: does not send duplicate outreach on subsequent worker turns', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'SM_sandbox_test_unique_1',
        status: 'QUEUED',
        provider: 'twilio_sandbox'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    // Turn 1: execute recovery and send WhatsApp
    await worker.pollOnce();
    expect(mockWhatsAppProvider.sendMessage).toHaveBeenCalledTimes(1);

    // Simulate worker lease re-drive by resetting case to QUEUED
    await repository.updateCase(eventResult.recoveryCase.id, {
      autonomyStatus: 'QUEUED',
      lockedUntil: null
    });

    // Turn 2: re-driven worker turn
    const turn2 = await worker.pollOnce();
    expect(turn2.processed).toBe(true);
    expect(turn2.status).toBe('BLOCKED');

    // WhatsApp must NOT be called a second time
    expect(mockWhatsAppProvider.sendMessage).toHaveBeenCalledTimes(1);

    // Actions list must contain exactly 1 CREATE_PAYMENT_LINK and 1 CUSTOMER_OUTREACH
    const actions = await repository.findActionsByCaseId(eventResult.recoveryCase.id);
    expect(actions).toHaveLength(2);
    expect(actions.filter((a) => a.actionType === 'CUSTOMER_OUTREACH')).toHaveLength(1);
  });

  it('6. Already-recovered stopping behavior: suppresses outreach if payment settled externally', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn()
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);

    // Mark case settled externally before worker claims it
    await repository.updateCase(eventResult.recoveryCase.id, {
      riskStatus: 'RESOLVED',
      outcome: 'RECOVERED',
      recoveredAmount: 499900
    });

    const runResult = await worker.pollOnce();
    expect(runResult.settled).toBe(true);
    expect(mockWhatsAppProvider.sendMessage).not.toHaveBeenCalled();

    const actions = await repository.findActionsByCaseId(eventResult.recoveryCase.id);
    expect(actions).toHaveLength(0);
  });

  it('7. Opt-out stopping behavior: suppresses outreach when customer opted out', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn()
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const optOutEvent = {
      ...baseFailedEvent,
      customerReference: 'opt_out_customer',
      rawPayload: {
        customerName: 'Opted Out User',
        customerPhone: '+919876543210',
        note: 'Customer requested do not contact'
      }
    };

    const eventResult = await processEvent(repository, optOutEvent);
    await repository.updateCase(eventResult.recoveryCase.id, {
      customerOptOut: true
    });

    await worker.pollOnce();
    // Outreach must be blocked by stopping engine
    expect(mockWhatsAppProvider.sendMessage).not.toHaveBeenCalled();
    const actions = await repository.findActionsByCaseId(eventResult.recoveryCase.id);
    expect(actions.some((a) => a.actionType === 'CUSTOMER_OUTREACH')).toBe(false);
  });

  it('8. Multilingual Grounding: generates Hinglish copy when customer preference is Hinglish', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'SM_sandbox_hinglish_1',
        status: 'QUEUED'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const hinglishEvent = {
      ...baseFailedEvent,
      rawPayload: {
        customerName: 'Vikram',
        customerPhone: '+919876543210',
        customerLanguagePreference: 'hinglish'
      }
    };

    await processEvent(repository, hinglishEvent);
    await worker.pollOnce();

    expect(mockWhatsAppProvider.sendMessage).toHaveBeenCalledTimes(1);
    const msg = mockWhatsAppProvider.sendMessage.mock.calls[0][0].message;
    expect(msg).toContain('₹4,999');
    expect(msg).toContain('payment complete');
    expect(msg).toContain('Vikram');
    expect(msg).toContain('https://rzp.io/i/');
  });

  it('9. CRITICAL INVARIANT: WhatsApp delivery NEVER credits recovered revenue', async () => {
    environment.AUTONOMOUS_WHATSAPP_ENABLED = true;
    const mockWhatsAppProvider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getProviderMode: vi.fn().mockReturnValue('SANDBOX'),
      sendMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'SM_revenue_check_1',
        status: 'QUEUED'
      })
    };

    const worker = createRecoveryWorker({
      repository,
      diagnosisService: mockDiagnosis,
      razorpayClient: mockRazorpay,
      whatsappProvider: mockWhatsAppProvider
    });

    const eventResult = await processEvent(repository, baseFailedEvent);
    await worker.pollOnce();

    const freshDetail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const freshCase = freshDetail.recoveryCase;
    expect(freshCase.riskStatus).toBe('RECOVERABLE');
    expect(freshCase.outcome).toBeNull();
    expect(freshCase.recoveredAmount).toBe(0);

    const detail = await repository.getCaseDetail(eventResult.recoveryCase.id);
    const outreachAction = detail.actions.find((a) => a.actionType === 'CUSTOMER_OUTREACH');
    expect(outreachAction.responseMetadata.recoveredAmount).toBe(0);
  });
});
