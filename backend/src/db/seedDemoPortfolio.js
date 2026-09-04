/**
 * Revflow — Demo Recovery Portfolio Seed
 *
 * Deterministically creates exactly 8 persistent demo recovery cases
 * in the isolated is_demo = true partition.
 *
 * INVARIANTS:
 * - is_demo is unconditionally true
 * - Safe to rerun (idempotent, skips existing payment IDs)
 * - Zero production rows (is_demo = false) created or modified
 * - ZERO Payment Links created (no actions executed)
 * - ZERO outcomes created (no fake recoveries)
 * - All cases initially in RECOVERABLE / OPEN state
 */

const { processEvent } = require('../services/eventService');
const { createDiagnosisService } = require('../ai/diagnosisService');

const DEMO_FIXTURES = [
  {
    id: 'DEMO_GW_TECH_01',
    name: 'Payment Gateway Technical Failure',
    scenarioKey: 'GATEWAY_TECHNICAL_FAILURE',
    amount: 499900, // ₹4,999
    currency: 'INR',
    customerReference: 'Demo Account 01',
    event: {
      eventId: 'evt_demo_gw_01',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_gw_01',
      orderId: 'order_demo_gw_01',
      amount: 499900,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Gateway 502 Bad Gateway: Upstream processor network error',
      customerReference: 'Demo Account 01',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'GATEWAY_ERROR',
        error_source: 'gateway',
        error_step: 'payment_processing',
        error_description: 'Upstream payment processor network error'
      }
    }
  },
  {
    id: 'DEMO_3DS_AUTH_02',
    name: '3DS Authentication Failure',
    scenarioKey: 'AUTHENTICATION_FAILURE',
    amount: 349900, // ₹3,499
    currency: 'INR',
    customerReference: 'Demo Account 02',
    event: {
      eventId: 'evt_demo_auth_02',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_auth_02',
      orderId: 'order_demo_auth_02',
      amount: 349900,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: '3DS authentication failed at issuer bank gateway: Customer did not complete OTP validation',
      customerReference: 'Demo Account 02',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'customer',
        error_step: 'payment_authentication',
        error_description: '3DS authentication failed due to invalid or expired OTP'
      }
    }
  },
  {
    id: 'DEMO_CARD_EXP_03',
    name: 'Payment Method Expired',
    scenarioKey: 'AUTHENTICATION_FAILURE',
    amount: 899900, // ₹8,999
    currency: 'INR',
    customerReference: 'Demo Account 03',
    event: {
      eventId: 'evt_demo_exp_03',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_exp_03',
      orderId: 'order_demo_exp_03',
      amount: 899900,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Card token expired on issuing bank: Expired card credentials on file',
      customerReference: 'Demo Account 03',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'CARD_EXPIRED',
        error_source: 'customer',
        error_step: 'payment_authorization',
        error_description: 'Saved card token has expired at issuer bank'
      }
    }
  },
  {
    id: 'DEMO_BANK_TIMEOUT_04',
    name: 'Issuer Bank Switch Timeout',
    scenarioKey: 'BANK_SWITCH_TIMEOUT',
    amount: 125000, // ₹1,250
    currency: 'INR',
    customerReference: 'Demo Account 04',
    event: {
      eventId: 'evt_demo_bst_04',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_bst_04',
      orderId: 'order_demo_bst_04',
      amount: 125000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Issuer bank switch timeout during processing',
      customerReference: 'Demo Account 04',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_description: 'Bank switch timeout during transaction authorization'
      }
    }
  },
  {
    id: 'DEMO_NETBANK_FAIL_05',
    name: 'Netbanking Gateway Timeout',
    scenarioKey: 'GATEWAY_TECHNICAL_FAILURE',
    amount: 699900, // ₹6,999
    currency: 'INR',
    customerReference: 'Demo Account 05',
    event: {
      eventId: 'evt_demo_net_05',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_net_05',
      orderId: 'order_demo_net_05',
      amount: 699900,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Netbanking gateway portal timed out during interbank transfer',
      customerReference: 'Demo Account 05',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'GATEWAY_ERROR',
        error_source: 'gateway',
        error_step: 'payment_processing',
        error_description: 'Netbanking gateway portal timed out during interbank transfer'
      }
    }
  },
  {
    id: 'DEMO_UPI_INTENT_06',
    name: 'UPI Switch Timeout',
    scenarioKey: 'BANK_SWITCH_TIMEOUT',
    amount: 250000, // ₹2,500
    currency: 'INR',
    customerReference: 'Demo Account 06',
    event: {
      eventId: 'evt_demo_upi_06',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_upi_06',
      orderId: 'order_demo_upi_06',
      amount: 250000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'UPI PSP switch timeout during intent flow',
      customerReference: 'Demo Account 06',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_description: 'UPI PSP switch timeout during intent flow'
      }
    }
  },
  {
    id: 'DEMO_ACQ_DROP_07',
    name: 'Acquirer Rail Degradation',
    scenarioKey: 'GATEWAY_TECHNICAL_FAILURE',
    amount: 250000, // ₹2,500
    currency: 'INR',
    customerReference: 'Demo Account 07',
    event: {
      eventId: 'evt_demo_acq_07',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_acq_07',
      orderId: 'order_demo_acq_07',
      amount: 250000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Acquirer rail degradation: Upstream gateway network reset',
      customerReference: 'Demo Account 07',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'GATEWAY_ERROR',
        error_source: 'gateway',
        error_step: 'payment_processing',
        error_description: 'Upstream gateway network reset'
      }
    }
  },
  {
    id: 'DEMO_CARD_DECLINE_08',
    name: 'Card Security Authorization Failure',
    scenarioKey: 'AUTHENTICATION_FAILURE',
    amount: 750000, // ₹7,500
    currency: 'INR',
    customerReference: 'Demo Account 08',
    event: {
      eventId: 'evt_demo_dec_08',
      eventType: 'payment.failed',
      paymentId: 'pay_demo_dec_08',
      orderId: 'order_demo_dec_08',
      amount: 750000,
      currency: 'INR',
      paymentStatus: 'failed',
      failureReason: 'Card authorization rejected by issuing bank gateway: Security risk filter',
      customerReference: 'Demo Account 08',
      timestamp: '2026-09-04T12:00:00.000Z',
      isDemo: true,
      rawPayload: {
        error_code: 'PAYMENT_RISK_CHECK_FAILED',
        error_source: 'customer',
        error_step: 'payment_authorization',
        error_description: 'Card authorization rejected by issuing bank gateway'
      }
    }
  }
];

async function seedDemoPortfolio(repository, { diagnosisService = createDiagnosisService() } = {}) {
  let createdCount = 0;
  let skippedCount = 0;
  const cases = [];

  for (const fixture of DEMO_FIXTURES) {
    const existingCase = await repository.findCaseByPaymentId(fixture.event.paymentId);
    if (existingCase) {
      skippedCount++;
      const existingDiag = await repository.findDiagnosisByCaseId(existingCase.id);
      if (!existingDiag) {
        const detail = await repository.getCaseDetail(existingCase.id);
        const decision = await diagnosisService.diagnose(detail);
        await repository.createDiagnosis({ recoveryCaseId: existingCase.id, ...decision });
      }
      cases.push(existingCase);
      continue;
    }

    const eventResult = await processEvent(repository, fixture.event);
    const recoveryCase = eventResult.recoveryCase;
    if (!recoveryCase) {
      continue;
    }

    const detail = await repository.getCaseDetail(recoveryCase.id);
    const decision = await diagnosisService.diagnose(detail);
    await repository.createDiagnosis({ recoveryCaseId: recoveryCase.id, ...decision });
    await repository.addAudit(recoveryCase.id, 'AI_DIAGNOSIS', `AI diagnosis accepted: ${decision.recommendation.action}`, {
      cause: decision.diagnosis.cause,
      confidence: decision.diagnosis.confidence,
      proposedAction: decision.proposedAction,
      recommendedAction: decision.recommendation.action,
      promptVersion: decision.promptVersion,
      provider: decision.provider,
      model: decision.model,
      source: decision.source
    });

    createdCount++;
    cases.push(recoveryCase);
  }

  return {
    createdCount,
    skippedCount,
    totalDemoCases: cases.length,
    cases
  };
}

if (require.main === module) {
  const { getPool, closePool } = require('./pool');
  const { PostgresRecoveryRepository } = require('../models/postgresRecoveryRepository');
  const pool = getPool();
  const repository = new PostgresRecoveryRepository(pool);

  seedDemoPortfolio(repository)
    .then((result) => {
      console.log(`Demo portfolio seed complete: ${result.createdCount} created, ${result.skippedCount} skipped, ${result.totalDemoCases} total.`);
    })
    .catch((err) => {
      console.error('Demo portfolio seed failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

module.exports = {
  DEMO_FIXTURES,
  seedDemoPortfolio
};
