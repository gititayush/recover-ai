"""
RecoverAI Evaluation — Rules-Only Baseline Evaluator
Implements the static, uncalibrated rules-only / naive dunning baseline.
Delegates outcome generation to the shared ground-truth customer response model.
"""

from typing import Dict, Any, List
from evaluation.response_model import simulate_customer_response

class RulesOnlyBaselineEvaluator:
    """
    Naive Dunning / Rules-Only Baseline:
    1. Blindly triggers an immediate Payment Link on every failure.
    2. No root-cause differentiation or AI diagnosis.
    3. Ignores cooldown windows (spams customer immediately).
    4. Ignores high-value thresholds (> INR 25,000 executed automatically without review).
    5. Fails to check terminal / refund / cancellation state.
    """

    def __init__(self):
        self.name = "Rules-Only Baseline (Naive Dunning)"

    def evaluate_case(self, case: Dict[str, Any]) -> Dict[str, Any]:
        # Baseline always chooses CREATE_PAYMENT_LINK and executes immediately
        action = "CREATE_PAYMENT_LINK"
        decision = "ALLOW"

        # Outcome simulated by shared ground-truth response model
        response = simulate_customer_response(case, action, decision)

        return {
            **response,
            "escalated_for_review": False,
            "stopped_by_policy": False
        }

    def evaluate_corpus(self, cases: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [self.evaluate_case(c) for c in cases]
