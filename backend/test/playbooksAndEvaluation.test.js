const request = require('supertest');
const { createApp } = require('../src/app');
const { InMemoryRecoveryRepository } = require('../src/models/inMemoryRecoveryRepository');
const { getAllPlaybooks, getPlaybookById } = require('../src/playbooks/playbookDefinitions');
const { evaluateCandidates } = require('../src/ai/interventionEvaluator');
const { evaluatePolicy } = require('../src/policy/policyEngine');

describe('Milestone 6 — Recovery Playbooks & Batch Evaluation', () => {

  describe('1. Seven Playbooks Catalog API', () => {
    it('returns all 7 Track 03 recovery playbooks with complete metadata', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const response = await request(app).get('/api/recovery/playbooks').expect(200);
      expect(response.body.playbooks).toHaveLength(7);

      const expectedIds = [
        'payment_degradation',
        'checkout_drop_off',
        'failed_subscription',
        'b2b_receivables',
        'mandate_retry',
        'hinglish_voice_recovery',
        'promise_to_pay'
      ];

      const returnedIds = response.body.playbooks.map((p) => p.id);
      expect(returnedIds).toEqual(expectedIds);

      // Verify flagship designation
      const flagship = response.body.playbooks.find((p) => p.flagship === true);
      expect(flagship).toBeDefined();
      expect(flagship.id).toBe('payment_degradation');
      expect(flagship.name).toContain('Payment Degradation');

      // Verify every playbook contains required schema fields
      for (const pb of response.body.playbooks) {
        expect(pb.name).toBeTruthy();
        expect(pb.domain).toBeTruthy();
        expect(pb.description).toBeTruthy();
        expect(pb.triggerPatterns.length).toBeGreaterThan(0);
        expect(pb.primaryCauses.length).toBeGreaterThan(0);
        expect(pb.candidateActions.length).toBeGreaterThan(0);
        expect(pb.policyConstraints.maxAttempts).toBeGreaterThanOrEqual(2);
        expect(pb.policyConstraints.cooldownMinutes).toBeGreaterThanOrEqual(30);
      }
    });

    it('getPlaybookById returns the exact playbook definition', () => {
      const b2b = getPlaybookById('b2b_receivables');
      expect(b2b).not.toBeNull();
      expect(b2b.domain).toBe('Wholesale & Invoicing');
      expect(b2b.policyConstraints.highValueReviewThreshold).toBe(2500000);

      const nonExistent = getPlaybookById('unknown_pb');
      expect(nonExistent).toBeNull();
    });
  });

  describe('2. Batch Evaluation API & Metrics Sanity', () => {
    it('GET /api/recovery/evaluation returns valid comparative benchmark metrics', async () => {
      const repository = new InMemoryRecoveryRepository();
      const app = createApp(repository);

      const response = await request(app).get('/api/recovery/evaluation').expect(200);
      const evalData = response.body;

      expect(evalData.metadata).toMatchObject({
        seed: 42,
        total_cases: 560,
        playbook_count: 7
      });

      const fm = evalData.financial_metrics;
      expect(fm.total_revenue_at_risk).toBeGreaterThan(0);
      expect(fm.recoverai_recovered_revenue).toBeGreaterThan(fm.baseline_recovered_revenue);
      expect(fm.incremental_recovered_revenue).toBe(fm.recoverai_recovered_revenue - fm.baseline_recovered_revenue);
      expect(fm.recoverai_recovery_rate).toBeGreaterThan(fm.baseline_recovery_rate);
      expect(fm.recoverai_net_economic_value).toBeGreaterThan(fm.baseline_net_economic_value);

      // Authentic Wilson Score Confidence Intervals
      const ci = fm.confidence_intervals;
      expect(ci.baseline_wilson_score_ci_95.lower).toBeLessThan(ci.baseline_wilson_score_ci_95.upper);
      expect(ci.recoverai_wilson_score_ci_95.lower).toBeLessThan(ci.recoverai_wilson_score_ci_95.upper);
      expect(ci.incremental_revenue_bootstrap_ci_95.bootstrap_ci_95.lower).toBeGreaterThan(0);

      // Paired Statistical Significance (McNemar's Test)
      const sig = fm.statistical_significance;
      expect(sig.test_name).toContain("McNemar");
      expect(sig.chi2_statistic).toBeGreaterThan(0);
      expect(typeof sig.p_value).toBe('number');
      expect(sig.p_value).toBeLessThan(0.05);

      const sm = evalData.safety_metrics;
      // RecoverAI GUARANTEES 0 unsafe actions and 0 duplicate retries
      expect(sm.unsafe_actions_recoverai).toBe(0);
      expect(sm.recoverai_duplicate_attempts).toBe(0);
      expect(sm.terminal_violations_recoverai).toBe(0);
      expect(sm.over_recovery_incidents).toBe(0);

      // Baseline has safety violations
      expect(sm.unsafe_actions_baseline).toBeGreaterThan(0);
      expect(sm.baseline_duplicate_attempts).toBeGreaterThan(0);
      expect(sm.duplicate_actions_prevented_by_policy).toBeGreaterThan(0);

      // Playbook breakdown covers all 7 playbooks
      expect(evalData.playbook_breakdown).toHaveLength(7);
      for (const pb of evalData.playbook_breakdown) {
        expect(pb.case_count).toBe(80);
        expect(pb.unsafe_actions_recoverai).toBe(0);
      }
    });

    it('reproducibility: generates identical metrics across independent evaluations', async () => {
      const { execSync } = require('child_process');
      const crypto = require('crypto');
      const fs = require('fs');

      execSync('python evaluation/benchmark_runner.py --seed 42 --cases-per-playbook 80', { stdio: 'pipe' });
      const summary1 = fs.readFileSync('evaluation/results/evaluation_summary.json');
      const hash1 = crypto.createHash('sha256').update(summary1).digest('hex');

      execSync('python evaluation/benchmark_runner.py --seed 42 --cases-per-playbook 80', { stdio: 'pipe' });
      const summary2 = fs.readFileSync('evaluation/results/evaluation_summary.json');
      const hash2 = crypto.createHash('sha256').update(summary2).digest('hex');

      expect(hash1).toBe(hash2);
    });
  });

  describe('3. Playbook-Specific Candidate Intervention Evaluation', () => {
    it('evaluates candidates for subscription and mandate playbooks with SCHEDULE_RETRY_WINDOW', () => {
      const contextSub = {
        amount: 899900,
        riskLevel: 'MEDIUM',
        failureReason: 'Recurring mandate declined due to token expiration',
        paymentAttemptCount: 1,
        playbook: 'failed_subscription'
      };

      const candidates = evaluateCandidates(contextSub);
      const retryAction = candidates.find((c) => c.action === 'SCHEDULE_RETRY_WINDOW');
      expect(retryAction).toBeDefined();
      expect(retryAction.estimatedProbability).toBeGreaterThan(0.3);
      expect(retryAction.recoverableAmount).toBe(899900);
    });

    it('evaluates candidates for Hinglish voice recovery with DISPATCH_VERNACULAR_ASSIST', () => {
      const contextVernacular = {
        amount: 189900,
        riskLevel: 'HIGH',
        failureReason: 'Customer confused by English-only banking authorization page',
        paymentAttemptCount: 2,
        playbook: 'hinglish_voice_recovery'
      };

      const candidates = evaluateCandidates(contextVernacular);
      const voiceAction = candidates.find((c) => c.action === 'DISPATCH_VERNACULAR_ASSIST');
      expect(voiceAction).toBeDefined();
      expect(voiceAction.estimatedProbability).toBeGreaterThan(0.5);
    });

    it('evaluates candidates for Promise to Pay with RECORD_PROMISE_TO_PAY', () => {
      const contextPromise = {
        amount: 750000,
        riskLevel: 'LOW',
        failureReason: 'Customer committed to pay on upcoming payday',
        paymentAttemptCount: 1,
        playbook: 'promise_to_pay'
      };

      const candidates = evaluateCandidates(contextPromise);
      const promiseAction = candidates.find((c) => c.action === 'RECORD_PROMISE_TO_PAY');
      expect(promiseAction).toBeDefined();
      expect(promiseAction.interventionCost).toBe(0);
    });
  });

  describe('4. Policy Guardrail Safety across Playbook Scenarios', () => {
    it('escalates high-value B2B receivable (> ₹25,000) to REVIEW', () => {
      const b2bCase = {
        id: 101,
        paymentId: 'pay_b2b_001',
        amount: 4500000, // ₹45,000 -> exceeds ₹25,000 threshold
        currency: 'INR',
        riskStatus: 'OPEN',
        paymentStatus: 'failed',
        failureReason: 'Corporate invoice overdue'
      };

      const decision = evaluatePolicy({
        recoveryCase: b2bCase,
        diagnosis: {
          diagnosis: { confidence: 0.95 },
          recommendation: { action: 'CREATE_PAYMENT_LINK' }
        },
        candidateAction: 'CREATE_PAYMENT_LINK',
        events: [{ timestamp: '2026-08-31T10:00:00.000Z' }],
        existingActions: [],
        isTestMode: true,
        now: () => new Date('2026-08-31T10:45:00.000Z')
      });

      expect(decision.decision).toBe('REVIEW');
      expect(decision.reasons.some((r) => r.includes('limit') || r.includes('exceeds'))).toBe(true);
    });

    it('instantly BLOCKs recovery action on refunded subscription case', () => {
      const refundedSubCase = {
        id: 102,
        paymentId: 'pay_sub_002',
        amount: 899900,
        currency: 'INR',
        riskStatus: 'SUPPRESSED',
        paymentStatus: 'refunded',
        failureReason: 'Customer cancelled subscription and received refund'
      };

      const decision = evaluatePolicy({
        recoveryCase: refundedSubCase,
        diagnosis: {
          diagnosis: { confidence: 0.9 },
          recommendation: { action: 'CREATE_PAYMENT_LINK' }
        },
        candidateAction: 'CREATE_PAYMENT_LINK',
        events: [{ timestamp: '2026-08-31T10:00:00.000Z' }],
        existingActions: [],
        isTestMode: true
      });

      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons.some((r) => r.includes('terminal') || r.includes('Case is in terminal status'))).toBe(true);
    });

    it('enforces active action rule preventing duplicate actions across all playbooks', () => {
      const executedCase = {
        id: 103,
        paymentId: 'pay_active_003',
        amount: 499900,
        currency: 'INR',
        riskStatus: 'RECOVERABLE',
        paymentStatus: 'failed'
      };

      const decision = evaluatePolicy({
        recoveryCase: executedCase,
        diagnosis: {
          diagnosis: { confidence: 0.9 },
          recommendation: { action: 'CREATE_PAYMENT_LINK' }
        },
        candidateAction: 'CREATE_PAYMENT_LINK',
        events: [{ timestamp: '2026-08-31T10:00:00.000Z' }],
        existingActions: [
          {
            id: 1,
            actionType: 'CREATE_PAYMENT_LINK',
            status: 'EXECUTED',
            createdAt: '2026-08-31T10:10:00.000Z'
          }
        ],
        isTestMode: true,
        now: () => new Date('2026-08-31T10:15:00.000Z') // Only 5 min later
      });

      expect(decision.decision).toBe('BLOCK');
      expect(decision.reasons.some((r) => r.includes('active or executed recovery action') || r.includes('already exists'))).toBe(true);
    });
  });

});