"""
Revflow Evaluation — Automated Python Test Suite
Tests deterministic hashing, shared response model fairness, Wilson score intervals,
McNemar paired testing, and end-to-end benchmark reproducibility.
"""

import hashlib
import json
import unittest
from evaluation.utils import (
    stable_uniform,
    wilson_score_interval,
    mcnemar_paired_test,
    paired_bootstrap_revenue_ci
)
from evaluation.response_model import simulate_customer_response, ACTION_COSTS
from evaluation.corpus_generator import generate_stratified_corpus
from evaluation.baseline_evaluator import RulesOnlyBaselineEvaluator
from evaluation.recoverai_evaluator import RecoverAiEvaluator
from evaluation.metrics_calculator import calculate_benchmark_metrics

class TestEvaluationRigorous(unittest.TestCase):

    def test_stable_uniform_determinism_and_range(self):
        # Must produce identical float across calls
        val1 = stable_uniform("test_key_123")
        val2 = stable_uniform("test_key_123")
        self.assertEqual(val1, val2)
        self.assertGreaterEqual(val1, 0.0)
        self.assertLess(val1, 1.0)

        # Different keys must produce different values
        val3 = stable_uniform("test_key_456")
        self.assertNotEqual(val1, val3)

    def test_authentic_wilson_score_interval(self):
        ci = wilson_score_interval(50, 100, confidence=0.95)
        self.assertEqual(ci["rate"], 0.5)
        # Wilson 95% CI for 50/100 is approx [0.4038, 0.5962]
        self.assertAlmostEqual(ci["lower"], 0.4038, delta=0.01)
        self.assertAlmostEqual(ci["upper"], 0.5962, delta=0.01)

    def test_mcnemar_paired_test_calculation(self):
        # Synthetic paired outcomes:
        # RecoverAI: [True]*30 + [False]*10
        # Baseline:   [False]*20 + [True]*10 + [False]*10
        rec = [True] * 30 + [False] * 10
        base = [False] * 20 + [True] * 10 + [False] * 10
        result = mcnemar_paired_test(rec, base)
        self.assertEqual(result["b_recoverai_only"], 20)
        self.assertEqual(result["c_baseline_only"], 0)
        self.assertGreater(result["chi2_statistic"], 10.0)
        self.assertTrue(result["significant_at_p01"])

    def test_shared_response_model_fairness(self):
        # Shared response model must produce identical outcome for identical input
        case = {
            "case_id": "case_test_001",
            "playbook_id": "payment_degradation",
            "amount": 500000,
            "true_conversion_propensity": 0.65,
            "is_terminal": False,
            "cooldown_active": False
        }

        resp1 = simulate_customer_response(case, "CREATE_PAYMENT_LINK", "ALLOW")
        resp2 = simulate_customer_response(case, "CREATE_PAYMENT_LINK", "ALLOW")
        self.assertEqual(resp1["is_recovered"], resp2["is_recovered"])
        self.assertEqual(resp1["recovered_amount"], resp2["recovered_amount"])
        self.assertEqual(resp1["effective_probability"], resp2["effective_probability"])

    def test_terminal_order_suppression(self):
        terminal_case = {
            "case_id": "case_test_002",
            "playbook_id": "failed_subscription",
            "amount": 899900,
            "true_conversion_propensity": 0.70,
            "is_terminal": True,
            "cooldown_active": False
        }

        # If an action is executed on a terminal order, it produces 0 recovery and marks unsafe
        unsafe_resp = simulate_customer_response(terminal_case, "CREATE_PAYMENT_LINK", "ALLOW")
        self.assertFalse(unsafe_resp["is_recovered"])
        self.assertEqual(unsafe_resp["recovered_amount"], 0)
        self.assertTrue(unsafe_resp["unsafe_action"])
        self.assertTrue(unsafe_resp["terminal_violation"])

        # If blocked by policy (as in RecoverAI), it is safe
        safe_resp = simulate_customer_response(terminal_case, "NO_ACTION", "BLOCK")
        self.assertFalse(safe_resp["is_recovered"])
        self.assertFalse(safe_resp["unsafe_action"])

    def test_end_to_end_benchmark_determinism(self):
        corpus1 = generate_stratified_corpus(seed=42, cases_per_playbook=20)
        corpus2 = generate_stratified_corpus(seed=42, cases_per_playbook=20)
        self.assertEqual(json.dumps(corpus1), json.dumps(corpus2))

        baseline = RulesOnlyBaselineEvaluator()
        recoverai = RecoverAiEvaluator()

        res_b1 = baseline.evaluate_corpus(corpus1["cases"])
        res_r1 = recoverai.evaluate_corpus(corpus1["cases"])

        res_b2 = baseline.evaluate_corpus(corpus2["cases"])
        res_r2 = recoverai.evaluate_corpus(corpus2["cases"])

        self.assertEqual(json.dumps(res_b1), json.dumps(res_b2))
        self.assertEqual(json.dumps(res_r1), json.dumps(res_r2))

        m1 = calculate_benchmark_metrics(corpus1, res_b1, res_r1)
        m2 = calculate_benchmark_metrics(corpus2, res_b2, res_r2)
        self.assertEqual(json.dumps(m1), json.dumps(m2))

if __name__ == "__main__":
    unittest.main()