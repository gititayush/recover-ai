"""
RecoverAI Evaluation â€” Shared Ground-Truth Customer Response Model
A single, unified response function shared identically by Baseline and RecoverAI.
Contains NO system-specific conversion bonuses or hard-coded multipliers.
"""

from typing import Dict, Any
from evaluation.utils import stable_uniform

# Transparent unit economics (in paise)
ACTION_COSTS = {
    "CREATE_PAYMENT_LINK": 50,          # â‚¹0.50 (Payment Link API fee)
    "REQUEST_MANUAL_REVIEW": 2500,      # â‚¹25.00 (Merchant agent manual review cost)
    "SCHEDULE_RETRY_WINDOW": 20,        # â‚¹0.20 (Scheduled batch retry fee)
    "DISPATCH_VERNACULAR_ASSIST": 100,  # â‚¹1.00 (WhatsApp/SMS bilingual assist fee)
    "RECORD_PROMISE_TO_PAY": 0,         # â‚¹0.00 (Deferred state tracking)
    "NO_ACTION": 0
}

def simulate_customer_response(
    case: Dict[str, Any],
    selected_action: str,
    policy_decision: str = "ALLOW"
) -> Dict[str, Any]:
    """
    Simulates customer payment response to an intervention using the shared ground-truth model.

    Parameters:
    - case: structured scenario containing amount, playbook_id, latent_intent, is_terminal, cooldown_active
    - selected_action: intervention chosen by the evaluating system
    - policy_decision: ALLOW, REVIEW, or BLOCK

    Both Baseline and RecoverAI pass their chosen action into this EXACT SAME function.
    """
    case_id = case["case_id"]
    amount = case["amount"]
    playbook_id = case["playbook_id"]
    is_terminal = case.get("is_terminal", False)
    cooldown_active = case.get("cooldown_active", False)
    latent_intent = case.get("true_conversion_propensity", 0.60)

    # 1. Safety Violation Tracking
    unsafe_action = False
    duplicate_action = False
    terminal_violation = False
    action_executed = (selected_action != "NO_ACTION" and policy_decision != "BLOCK")

    # If action executed on a terminal/cancelled/refunded transaction:
    if action_executed and is_terminal:
        unsafe_action = True
        terminal_violation = True

    # If action executed within cooldown window:
    if action_executed and cooldown_active:
        duplicate_action = True

    # 2. Probability Computation based on Action-to-Root-Cause Fit
    if not action_executed or selected_action == "NO_ACTION" or policy_decision == "BLOCK":
        # Blocked or abstained: no money recovered, zero intervention cost
        effective_probability = 0.0
        intervention_cost = 0
        friction_penalty = 0

    elif is_terminal:
        # A cancelled or refunded order will never pay
        effective_probability = 0.0
        intervention_cost = ACTION_COSTS.get(selected_action, 50)
        friction_penalty = int(amount * 0.15) # Heavy penalty for contacting cancelled customer

    else:
        # Action is executed on an active, eligible failure case.
        # Channel fit is determined by domain alignment:
        base_intent = latent_intent

        if selected_action == "CREATE_PAYMENT_LINK":
            # Highly effective for gateway timeouts and cart abandonment
            # Lower conversion on high-value B2B (needs procurement approval) or vernacular confusion
            if playbook_id == "b2b_receivables" and amount >= 2500000:
                channel_multiplier = 0.70 # Unassisted link on large corporate invoice
            elif playbook_id == "hinglish_voice_recovery":
                channel_multiplier = 0.75 # English payment link on vernacular user
            elif playbook_id in ["failed_subscription", "mandate_retry"] and case.get("attempt_count", 1) > 1:
                channel_multiplier = 0.80 # Immediate link when balance is still empty
            else:
                channel_multiplier = 1.00 # Standard effective link

        elif selected_action == "REQUEST_MANUAL_REVIEW":
            # Human agent handles high-value corporate invoice or complex dispute
            if amount >= 2500000 or playbook_id == "b2b_receivables":
                channel_multiplier = 1.15 # Human outreach resolves corporate approval blockers
            else:
                channel_multiplier = 0.95

        elif selected_action == "SCHEDULE_RETRY_WINDOW":
            # Retrying post-salary date resolves timing mismatch
            if playbook_id in ["failed_subscription", "mandate_retry"]:
                channel_multiplier = 1.10
            else:
                channel_multiplier = 0.90

        elif selected_action == "DISPATCH_VERNACULAR_ASSIST":
            # Vernacular guidance resolves PIN/OTP confusion
            if playbook_id == "hinglish_voice_recovery":
                channel_multiplier = 1.12
            else:
                channel_multiplier = 0.95

        elif selected_action == "RECORD_PROMISE_TO_PAY":
            # Honoring promise date prevents annoyance churn
            if playbook_id == "promise_to_pay":
                channel_multiplier = 1.10
            else:
                channel_multiplier = 0.90
        else:
            channel_multiplier = 1.00

        # Customer fatigue discount if duplicate action executed during cooldown:
        if duplicate_action:
            channel_multiplier *= 0.75

        effective_probability = min(0.92, max(0.05, base_intent * channel_multiplier))
        intervention_cost = ACTION_COSTS.get(selected_action, 50)
        friction_penalty = int(amount * (0.08 if duplicate_action else 0.02))

    # 3. Deterministic Outcome Sampling via Stable SHA-256 Hash
    # Hash key incorporates case_id and action to guarantee identical results across runs
    outcome_hash_key = f"outcome_{case_id}_{selected_action}_{policy_decision}"
    uniform_sample = stable_uniform(outcome_hash_key)

    is_recovered = (uniform_sample < effective_probability) and (effective_probability > 0.0)
    recovered_amount = amount if is_recovered else 0

    net_value = (recovered_amount - intervention_cost - friction_penalty) if is_recovered else (-intervention_cost - friction_penalty)

    return {
        "case_id": case_id,
        "playbook_id": playbook_id,
        "amount": amount,
        "selected_action": selected_action,
        "policy_decision": policy_decision,
        "action_executed": action_executed,
        "effective_probability": round(effective_probability, 4),
        "is_recovered": is_recovered,
        "recovered_amount": recovered_amount,
        "unsafe_action": unsafe_action,
        "duplicate_action": duplicate_action,
        "terminal_violation": terminal_violation,
        "intervention_cost": intervention_cost,
        "friction_penalty": friction_penalty,
        "net_value": net_value
    }
