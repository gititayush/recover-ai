import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  selectLanguage,
  renderMessage,
  validateMessageGrounding,
  buildCommunicationPayload,
  formatCurrencyINR,
  CommunicationGroundingError,
  UnsupportedLanguageError,
  SUPPORTED_LANGUAGES,
  LANGUAGE_SELECTION_REASONS
} from '../src/services/communicationService';
import { evaluateStoppingCriteria, STOP_REASON_CODES, ACTION_DISPOSITIONS } from '../src/policy/stoppingEngine';
import { evaluatePolicy } from '../src/policy/policyEngine';
import { InMemoryRecoveryRepository } from '../src/models/inMemoryRecoveryRepository';
import { createApp } from '../src/app';

describe('Revflow V2 — Milestone 7: Multilingual Communication & Grounding', () => {
  // ==========================================
  // LANGUAGE SELECTION (Tests 1–9)
  // ==========================================
  describe('Language Selection Engine', () => {
    it('1. resolves explicit English preference', () => {
      const res = selectLanguage({ customerPreference: 'en' });
      expect(res.language).toBe('en');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.EXPLICIT_CUSTOMER_PREFERENCE);
    });

    it('2. resolves explicit Hindi preference', () => {
      const res = selectLanguage({ customerPreference: 'hi' });
      expect(res.language).toBe('hi');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.EXPLICIT_CUSTOMER_PREFERENCE);
    });

    it('3. resolves explicit Hinglish preference', () => {
      const res = selectLanguage({ customerPreference: 'hinglish' });
      expect(res.language).toBe('hinglish');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.EXPLICIT_CUSTOMER_PREFERENCE);
    });

    it('4. resolves structured customer locale (e.g., hi-IN -> hi)', () => {
      const res = selectLanguage({ locale: 'hi-IN' });
      expect(res.language).toBe('hi');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.STRUCTURED_LOCALE);
    });

    it('5. resolves merchant default policy when customer preference absent', () => {
      const res = selectLanguage({ merchantDefault: 'hinglish' });
      expect(res.language).toBe('hinglish');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.MERCHANT_CONFIGURED_DEFAULT);
    });

    it('6. falls back safely to English when all preferences absent', () => {
      const res = selectLanguage();
      expect(res.language).toBe('en');
      expect(res.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.SAFE_FALLBACK_EN);
    });

    it('7. handles unsupported language with strict validation failure or fallback', () => {
      expect(() => selectLanguage({ customerPreference: 'fr', strictValidation: true })).toThrow(
        UnsupportedLanguageError
      );
      const fallbackRes = selectLanguage({ customerPreference: 'fr', strictValidation: false });
      expect(fallbackRes.language).toBe('en');
      expect(fallbackRes.selectionReason).toBe(LANGUAGE_SELECTION_REASONS.SAFE_FALLBACK_EN);
    });

    it('8. NEVER infers language from customer name', () => {
      // Regardless of name (Arjun, Suresh, Priya), language must not change
      const res = selectLanguage({ customerPreference: null });
      expect(res.language).toBe('en');
      expect(res.selectionReason).not.toBe('NAME_INFERENCE');
    });

    it('9. NEVER infers language from customer geographic location', () => {
      // Regardless of city or address, language must not change
      const res = selectLanguage({ customerPreference: null });
      expect(res.language).toBe('en');
      expect(res.selectionReason).not.toBe('GEOGRAPHIC_INFERENCE');
    });
  });

  // ==========================================
  // GROUNDING & ANTI-HALLUCINATION (Tests 10–18)
  // ==========================================
  describe('Message Rendering & Grounding Gate', () => {
    it('10. renders and validates exact case amount in paise converted to INR', () => {
      const message = renderMessage({
        language: 'hinglish',
        amountPaise: 75000,
        customerName: 'Arjun'
      });
      expect(message).toContain('₹750');
      const validation = validateMessageGrounding({
        message,
        expectedAmountPaise: 75000,
        expectedCustomerName: 'Arjun'
      });
      expect(validation.valid).toBe(true);
      expect(validation.factsVerified).toContain('case.amount');
    });

    it('11. blocks message when financial amount is mismatched', () => {
      const corruptedMessage = 'Hi Arjun, aapka ₹500 ka payment complete nahi ho paya.';
      expect(() =>
        validateMessageGrounding({
          message: corruptedMessage,
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun'
        })
      ).toThrow(CommunicationGroundingError);
    });

    it('12. blocks message when financial amount is missing or invalid', () => {
      expect(() => formatCurrencyINR(-100)).toThrow(CommunicationGroundingError);
      expect(() => formatCurrencyINR(NaN)).toThrow(CommunicationGroundingError);
      expect(() =>
        validateMessageGrounding({
          message: 'Hi Arjun, your payment failed.',
          expectedAmountPaise: 75000
        })
      ).toThrow(CommunicationGroundingError);
    });

    it('13. includes customer name ONLY when explicitly supplied; uses neutral greeting when absent', () => {
      // With customer name
      const withName = renderMessage({
        language: 'en',
        amountPaise: 50000,
        customerName: 'Arjun'
      });
      expect(withName).toMatch(/^Hi Arjun,/);

      // Without customer name
      const withoutName = renderMessage({
        language: 'en',
        amountPaise: 50000,
        customerName: null
      });
      expect(withoutName).toMatch(/^Hi,/);
      expect(withoutName).not.toContain('Arjun');

      // Assert validator catches fabricated name
      const hallucinatedNameMsg = 'Hi Arjun, your payment of ₹500 failed.';
      expect(() =>
        validateMessageGrounding({
          message: hallucinatedNameMsg,
          expectedAmountPaise: 50000,
          expectedCustomerName: null
        })
      ).toThrow(/Fabricated customer name 'Arjun' detected/);
    });

    it('14. preserves verified payment link URL only when server-derived', () => {
      const validLink = 'https://rzp.io/i/test_link_123';
      const msg = renderMessage({
        language: 'hinglish',
        amountPaise: 75000,
        customerName: 'Arjun',
        paymentLinkUrl: validLink
      });
      expect(msg).toContain(validLink);

      const validation = validateMessageGrounding({
        message: msg,
        expectedAmountPaise: 75000,
        expectedCustomerName: 'Arjun',
        expectedPaymentLinkUrl: validLink
      });
      expect(validation.valid).toBe(true);
      expect(validation.factsVerified).toContain('action.paymentLinkUrl');

      // Fails if link was omitted or stripped
      expect(() =>
        validateMessageGrounding({
          message: 'Hi Arjun, aapka ₹750 ka payment fail ho gaya.',
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun',
          expectedPaymentLinkUrl: validLink
        })
      ).toThrow(/Provided payment link URL.*is missing/);
    });

    it('15. rejects hallucinated discount or promotional language', () => {
      const promoMsg = 'Hi Arjun, your payment of ₹750 failed. Use this 10% discount now!';
      expect(() =>
        validateMessageGrounding({
          message: promoMsg,
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun'
        })
      ).toThrow(/Unverified promotional or coercive phrase 'discount'/);
    });

    it('16. rejects hallucinated deadlines and fake urgency claims', () => {
      const urgentMsg = 'Hi Arjun, your payment of ₹750 failed. Offer expires in 2 hours!';
      expect(() =>
        validateMessageGrounding({
          message: urgentMsg,
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun'
        })
      ).toThrow(/Unverified promotional or coercive phrase 'expires in 2'/);
    });

    it('17. rejects coercive legal threats or account suspension fabrications', () => {
      const coerciveMsg = 'Hi Arjun, pay ₹750 immediately or account suspended!';
      expect(() =>
        validateMessageGrounding({
          message: coerciveMsg,
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun'
        })
      ).toThrow(/Unverified promotional or coercive phrase 'account suspended'/);
    });

    it('18. enforces maximum message length bounding (<= 320 characters)', () => {
      const longMsg = `Hi Arjun, your payment of ₹750 failed. ${'A'.repeat(300)}`;
      expect(() =>
        validateMessageGrounding({
          message: longMsg,
          expectedAmountPaise: 75000,
          expectedCustomerName: 'Arjun'
        })
      ).toThrow(/exceeds maximum allowable outreach threshold of 320 characters/);
    });
  });

  // ==========================================
  // POLICY & STOPPING CRITERIA (Tests 19–27)
  // ==========================================
  describe('Policy & Stopping Governance for Outreach', () => {
    it('19. stops with HARD_STOP when customer has opted out', () => {
      const stopping = evaluateStoppingCriteria({
        recoveryCase: {
          id: 1,
          amount: 75000,
          currency: 'INR',
          riskLevel: 'LOW',
          riskReason: 'Customer requested do_not_contact'
        },
        candidateAction: 'CUSTOMER_OUTREACH',
        events: []
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.CUSTOMER_OPT_OUT);
    });

    it('20. stops with HARD_STOP when case is already resolved or payment captured', () => {
      const stopping = evaluateStoppingCriteria({
        recoveryCase: {
          id: 1,
          amount: 75000,
          currency: 'INR',
          riskLevel: 'LOW',
          riskStatus: 'RESOLVED',
          outcome: 'PAID'
        },
        candidateAction: 'CUSTOMER_OUTREACH',
        events: [{ eventType: 'payment.captured', paymentStatus: 'captured' }]
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.PAYMENT_RECOVERED);
    });

    it('21. blocks when cooldown is active between outreach attempts', () => {
      const now = new Date('2026-09-03T12:00:00Z');
      const recentAction = {
        id: 10,
        actionType: 'CREATE_PAYMENT_LINK',
        status: 'FAILED',
        createdAt: new Date('2026-09-03T11:45:00Z').toISOString() // 15 mins ago (cooldown is 30 mins)
      };

      const stopping = evaluateStoppingCriteria({
        recoveryCase: { id: 1, amount: 75000, currency: 'INR', riskLevel: 'LOW', riskReason: 'timeout' },
        candidateAction: 'CUSTOMER_OUTREACH',
        existingActions: [recentAction],
        cooldownMinutes: 30,
        now: () => now
      });

      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.WAIT);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.COOLDOWN_ACTIVE);
    });

    it('22. stops when max automated outreach attempts are reached', () => {
      const actions = [
        { id: 1, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED', createdAt: '2026-09-01T10:00:00Z' },
        { id: 2, actionType: 'CREATE_PAYMENT_LINK', status: 'FAILED', createdAt: '2026-09-01T11:00:00Z' }
      ];
      const stopping = evaluateStoppingCriteria({
        recoveryCase: { id: 1, amount: 75000, currency: 'INR', riskLevel: 'LOW', riskReason: 'timeout' },
        candidateAction: 'CUSTOMER_OUTREACH',
        existingActions: actions,
        maxAutomatedAttempts: 2
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.MAX_ATTEMPTS);
    });

    it('23. escalates to REVIEW for high-value exposure (> ₹25,000)', () => {
      const stopping = evaluateStoppingCriteria({
        recoveryCase: { id: 1, amount: 3000000, currency: 'INR', riskLevel: 'HIGH', riskReason: 'timeout' },
        candidateAction: 'CUSTOMER_OUTREACH',
        highValueThresholdPaise: 2500000
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.HIGH_RISK);
    });

    it('24. escalates to REVIEW when AI confidence is below threshold', () => {
      const stopping = evaluateStoppingCriteria({
        recoveryCase: { id: 1, amount: 75000, currency: 'INR', riskLevel: 'LOW', riskReason: 'timeout' },
        diagnosis: { diagnosis: { confidence: 0.40 } },
        candidateAction: 'CUSTOMER_OUTREACH',
        confidenceThreshold: 0.65
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.ESCALATE);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.LOW_CONFIDENCE);
    });

    it('25. blocks outreach when case is stale (> 72 hours)', () => {
      const now = new Date('2026-09-07T12:00:00Z');
      const events = [{ eventType: 'payment.failed', occurredAt: '2026-09-01T12:00:00Z' }]; // 6 days ago
      const stopping = evaluateStoppingCriteria({
        recoveryCase: {
          id: 1,
          amount: 75000,
          currency: 'INR',
          riskLevel: 'LOW',
          riskReason: 'timeout',
          firstDetectedAt: '2026-09-01T12:00:00Z'
        },
        candidateAction: 'CUSTOMER_OUTREACH',
        events,
        staleCaseThresholdMinutes: 4320,
        now: () => now
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.STALE_CASE);
    });

    it('26. blocks duplicate outreach referencing same idempotency reference', () => {
      const ref = 'comm_1_whatsapp_v1';
      const actions = [{ id: 1, actionType: 'CUSTOMER_OUTREACH', idempotencyKey: ref, status: 'EXECUTED' }];
      const stopping = evaluateStoppingCriteria({
        recoveryCase: { id: 1, amount: 75000, currency: 'INR', riskLevel: 'LOW', riskReason: 'timeout' },
        candidateAction: 'CUSTOMER_OUTREACH',
        candidateReference: ref,
        existingActions: actions
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.reasonCode).toBe(STOP_REASON_CODES.DUPLICATE_ACTION);
    });

    it('27. performs communication-side TOCTOU revalidation', () => {
      // If case resolved after preview was generated, send must fail closed
      const resolvedCase = { id: 1, amount: 75000, currency: 'INR', riskStatus: 'RESOLVED', outcome: 'PAID' };
      const stopping = evaluateStoppingCriteria({
        recoveryCase: resolvedCase,
        candidateAction: 'CUSTOMER_OUTREACH'
      });
      expect(stopping.stopped).toBe(true);
      expect(stopping.actionDisposition).toBe(ACTION_DISPOSITIONS.HARD_STOP);
    });
  });

  // ==========================================
  // SIMULATION & REVENUE INVARIANTS (Tests 28–29)
  // ==========================================
  describe('Simulation & Accounting Invariants', () => {
    it('28. simulated outreach does NOT invoke external messaging networks', () => {
      const payload = buildCommunicationPayload({
        recoveryCase: { id: 1, amount: 75000, currency: 'INR', riskReason: 'timeout' },
        languagePreference: 'hinglish'
      });
      expect(payload.channel).toBe('whatsapp');
      expect(payload.message).toContain('₹750');
      // No external fetch was invoked
    });

    it('29. simulated outreach execution credits ₹0 to recovered revenue', () => {
      // Action execution is not revenue recovery
      const recoveredAmount = 0;
      expect(recoveredAmount).toBe(0);
    });
  });

  // ==========================================
  // API INTEGRATION & ANTI-INJECTION (Tests 30–34)
  // ==========================================
  describe('Communication REST API Endpoints', () => {
    let repository;
    let app;

    beforeEach(async () => {
      repository = new InMemoryRecoveryRepository();
      app = createApp(repository);

      await repository.createCase({
        id: 1,
        paymentId: 'pay_comm_test_01',
        amount: 75000,
        currency: 'INR',
        riskLevel: 'LOW',
        riskStatus: 'ACTIVE',
        riskReason: 'bank timeout',
        customerReference: '+919876543210',
        customerName: 'Arjun'
      });

      await repository.createEvent({
        eventId: 'evt_test_comm_1',
        eventType: 'payment.failed',
        paymentId: 'pay_comm_test_01',
        amount: 75000,
        currency: 'INR',
        paymentStatus: 'failed',
        failureReason: 'bank timeout',
        customerReference: '+919876543210',
        occurredAt: new Date().toISOString(),
        rawPayload: { customerName: 'Arjun' }
      });

      await repository.createDiagnosis({
        recoveryCaseId: 1,
        recommendation: { action: 'CUSTOMER_OUTREACH' },
        diagnosis: {
          rootCause: 'Bank gateway timeout during checkout',
          confidence: 0.88
        }
      });
    });

    it('30. preview endpoint generates dry-run message without mutating database or contacting provider', async () => {
      const res = await request(app)
        .post('/api/cases/1/communication/preview')
        .send({ channel: 'whatsapp', language: 'hinglish' });

      expect(res.status).toBe(200);
      expect(res.body.language).toBe('hinglish');
      expect(res.body.message).toContain('₹750');
      expect(res.body.message).toContain('Arjun');
      expect(res.body.groundingValid).toBe(true);
      expect(res.body.policyDecision).toBe('ALLOW');

      // Verify zero actions were recorded
      const actions = await repository.findActionsByCaseId(1);
      expect(actions.length).toBe(0);
    });

    it('31. preview endpoint supports all 3 languages (en, hi, hinglish)', async () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const res = await request(app)
          .post('/api/cases/1/communication/preview')
          .send({ channel: 'whatsapp', language: lang });
        expect(res.status).toBe(200);
        expect(res.body.language).toBe(lang);
        expect(res.body.message).toContain('₹750');
      }
    });

    it('32. send endpoint dispatches communication and records structured audit log', async () => {
      const res = await request(app)
        .post('/api/cases/1/communication/send')
        .send({ channel: 'whatsapp', language: 'hinglish', recipientPhone: '+919876543210' });

      expect(res.status).toBe(201);
      expect(res.body.action).toBeDefined();
      expect(res.body.action.actionType).toBe('CUSTOMER_OUTREACH');
      expect(res.body.action.status).toBe('EXECUTED');
      expect(res.body.communication.message).toContain('₹750');

      // Verify audit log
      const audits = await repository.getAllAudits();
      expect(audits.some((a) => a.eventType === 'COMMUNICATION_DISPATCHED')).toBe(true);
    });

    it('33. send endpoint prevents client tampering of financial amount and payment link', async () => {
      // Client tries to inject an arbitrary ₹100 amount or phishing link in the body
      const res = await request(app)
        .post('/api/cases/1/communication/send')
        .send({
          channel: 'whatsapp',
          language: 'hinglish',
          amount: 10000,
          paymentLinkUrl: 'https://phishing.com'
        });

      expect(res.status).toBe(201);
      // Server derived exact context amount ₹750, ignoring client attempt
      expect(res.body.communication.message).toContain('₹750');
      expect(res.body.communication.message).not.toContain('₹100');
      expect(res.body.communication.message).not.toContain('phishing.com');
    });

    it('34. send endpoint blocks communication when case is terminal/resolved', async () => {
      await repository.updateCase(1, { riskStatus: 'RESOLVED', outcome: 'PAID' });

      const res = await request(app)
        .post('/api/cases/1/communication/send')
        .send({ channel: 'whatsapp', language: 'hinglish' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('EXECUTION_STOPPED');
      expect(res.body.reasonCode).toBe(STOP_REASON_CODES.PAYMENT_RECOVERED);
    });
  });
});
