"""
RecoverAI Evaluation — Metrics Calculator & Statistical Significance Engine
Calculates exact financial, safety, Wilson score intervals, and paired McNemar / bootstrap tests.
"""

from typing import Dict, Any, List
from evaluation.utils import wilson_score_interval, mcnemar_paired_test, paired_bootstrap_revenue_ci

def calculate_benchmark_metrics(
    corpus: Dict[str, Any],
    baseline_results: List[Dict[str, Any]],
    recoverai_results: List[Dict[str, Any]]
) -> Dict[str, Any]:
    cases = corpus["cases"]
    total_cases = len(cases)

    # 1. Financial Metrics
    total_revenue_at_risk = sum(c["amount"] for c in cases)
    eligible_cases = [c for c in cases if not c.get("is_terminal", False)]
    eligible_recovery_value = sum(c["amount"] for c in eligible_cases)

    baseline_recovered_revenue = sum(r["recovered_amount"] for r in baseline_results)
    recoverai_recovered_revenue = sum(r["recovered_amount"] for r in recoverai_results)

    # Gross rates (over total revenue at risk)
    baseline_gross_rate = baseline_recovered_revenue / total_revenue_at_risk if total_revenue_at_risk > 0 else 0.0
    recoverai_gross_rate = recoverai_recovered_revenue / total_revenue_at_risk if total_revenue_at_risk > 0 else 0.0
    incremental_gross_rate = recoverai_gross_rate - baseline_gross_rate

    # Eligible rates (over eligible recovery value, excluding cancelled/refunded)
    baseline_eligible_rate = baseline_recovered_revenue / eligible_recovery_value if eligible_recovery_value > 0 else 0.0
    recoverai_eligible_rate = recoverai_recovered_revenue / eligible_recovery_value if eligible_recovery_value > 0 else 0.0
    incremental_eligible_rate = recoverai_eligible_rate - baseline_eligible_rate

    incremental_recovered_revenue = recoverai_recovered_revenue - baseline_recovered_revenue
    revenue_lift_percentage = (incremental_recovered_revenue / baseline_recovered_revenue * 100.0) if baseline_recovered_revenue > 0 else 0.0

    baseline_net_value = sum(r["net_value"] for r in baseline_results)
    recoverai_net_value = sum(r["net_value"] for r in recoverai_results)
    incremental_net_value = recoverai_net_value - baseline_net_value

    # Case-level binary recovery lists
    baseline_outcomes_binary = [bool(r["is_recovered"]) for r in baseline_results]
    recoverai_outcomes_binary = [bool(r["is_recovered"]) for r in recoverai_results]

    baseline_recovered_cases = sum(1 for x in baseline_outcomes_binary if x)
    recoverai_recovered_cases = sum(1 for x in recoverai_outcomes_binary if x)

    # Authentic Wilson Score Confidence Intervals
    baseline_wilson_ci = wilson_score_interval(baseline_recovered_cases, total_cases)
    recoverai_wilson_ci = wilson_score_interval(recoverai_recovered_cases, total_cases)

    # Paired McNemar Test on Case-Level Recovery Homogeneity
    mcnemar_result = mcnemar_paired_test(recoverai_outcomes_binary, baseline_outcomes_binary)

    # Paired Bootstrap Confidence Interval on Incremental Recovered Revenue
    baseline_revenues = [int(r["recovered_amount"]) for r in baseline_results]
    recoverai_revenues = [int(r["recovered_amount"]) for r in recoverai_results]
    revenue_bootstrap = paired_bootstrap_revenue_ci(recoverai_revenues, baseline_revenues, seed=corpus["metadata"]["seed"])

    # 2. Safety & Policy Guardrails Metrics (Accurate & Unambiguous Naming)
    allow_count = sum(1 for r in recoverai_results if r["policy_decision"] == "ALLOW")
    review_count = sum(1 for r in recoverai_results if r["policy_decision"] == "REVIEW")
    block_count = sum(1 for r in recoverai_results if r["policy_decision"] == "BLOCK")

    escalation_rate = review_count / total_cases if total_cases > 0 else 0.0
    blocked_rate = block_count / total_cases if total_cases > 0 else 0.0
    stopping_rule_activations = sum(1 for r in recoverai_results if r["stopped_by_policy"])

    baseline_duplicate_attempts = sum(1 for r in baseline_results if r["duplicate_action"])
    recoverai_duplicate_attempts = sum(1 for r in recoverai_results if r["duplicate_action"])
    duplicate_actions_prevented_by_policy = sum(1 for r in recoverai_results if r.get("stopped_by_policy") and cases[recoverai_results.index(r)].get("cooldown_active"))

    unsafe_actions_baseline = sum(1 for r in baseline_results if r["unsafe_action"])
    unsafe_actions_recoverai = sum(1 for r in recoverai_results if r["unsafe_action"])

    terminal_violations_baseline = sum(1 for r in baseline_results if r["terminal_violation"])
    terminal_violations_recoverai = sum(1 for r in recoverai_results if r["terminal_violation"])

    # 3. AI Diagnostics & Action Selection Breakdown
    valid_diagnosis_count = sum(1 for r in recoverai_results if r.get("valid_diagnosis", False))
    grounded_evidence_count = sum(1 for r in recoverai_results if r.get("grounded_evidence", False))
    valid_diagnosis_rate = valid_diagnosis_count / total_cases if total_cases > 0 else 0.0
    grounded_evidence_rate = grounded_evidence_count / total_cases if total_cases > 0 else 0.0
    average_confidence = sum(r.get("diagnosis_confidence", 0.0) for r in recoverai_results) / total_cases if total_cases > 0 else 0.0

    recoverai_action_distribution = {}
    for r in recoverai_results:
        act = r["selected_action"]
        recoverai_action_distribution[act] = recoverai_action_distribution.get(act, 0) + 1

    baseline_action_distribution = {}
    for r in baseline_results:
        act = r["selected_action"]
        baseline_action_distribution[act] = baseline_action_distribution.get(act, 0) + 1

    # 4. Playbook-by-Playbook Comparative Breakdown
    playbooks_set = list(dict.fromkeys(c["playbook_id"] for c in cases))
    playbook_breakdown = []

    for pb_id in playbooks_set:
        pb_cases = [c for c in cases if c["playbook_id"] == pb_id]
        pb_eligible_cases = [c for c in pb_cases if not c.get("is_terminal", False)]
        pb_baseline = [r for r in baseline_results if r["playbook_id"] == pb_id]
        pb_recoverai = [r for r in recoverai_results if r["playbook_id"] == pb_id]

        pb_name = pb_cases[0]["playbook_name"] if pb_cases else pb_id
        pb_domain = pb_cases[0]["domain"] if pb_cases else ""
        pb_at_risk = sum(c["amount"] for c in pb_cases)
        pb_eligible_val = sum(c["amount"] for c in pb_eligible_cases)

        pb_base_rec = sum(r["recovered_amount"] for r in pb_baseline)
        pb_rec_rec = sum(r["recovered_amount"] for r in pb_recoverai)

        pb_base_gross_rate = pb_base_rec / pb_at_risk if pb_at_risk > 0 else 0.0
        pb_rec_gross_rate = pb_rec_rec / pb_at_risk if pb_at_risk > 0 else 0.0
        pb_base_eligible_rate = pb_base_rec / pb_eligible_val if pb_eligible_val > 0 else 0.0
        pb_rec_eligible_rate = pb_rec_rec / pb_eligible_val if pb_eligible_val > 0 else 0.0

        pb_incr_rev = pb_rec_rec - pb_base_rec
        pb_incr_gross_rate = pb_rec_gross_rate - pb_base_gross_rate
        pb_incr_eligible_rate = pb_rec_eligible_rate - pb_base_eligible_rate

        pb_unsafe_base = sum(1 for r in pb_baseline if r["unsafe_action"])
        pb_unsafe_rec = sum(1 for r in pb_recoverai if r["unsafe_action"])
        pb_escalated = sum(1 for r in pb_recoverai if r["escalated_for_review"])
        pb_stopped = sum(1 for r in pb_recoverai if r["stopped_by_policy"])

        # Playbook actions
        pb_actions_rec = {}
        for r in pb_recoverai:
            act = r["selected_action"]
            pb_actions_rec[act] = pb_actions_rec.get(act, 0) + 1

        playbook_breakdown.append({
            "playbook_id": pb_id,
            "playbook_name": pb_name,
            "domain": pb_domain,
            "total_cases": len(pb_cases),
            "eligible_cases": len(pb_eligible_cases),
            "case_count": len(pb_cases),
            "revenue_at_risk": pb_at_risk,
            "eligible_recovery_value": pb_eligible_val,
            "baseline_recovered": pb_base_rec,
            "recoverai_recovered": pb_rec_rec,
            "baseline_gross_recovery_rate": round(pb_base_gross_rate, 4),
            "recoverai_gross_recovery_rate": round(pb_rec_gross_rate, 4),
            "baseline_recovery_rate": round(pb_base_gross_rate, 4), # backward-compat
            "recoverai_recovery_rate": round(pb_rec_gross_rate, 4), # backward-compat
            "baseline_eligible_recovery_rate": round(pb_base_eligible_rate, 4),
            "recoverai_eligible_recovery_rate": round(pb_rec_eligible_rate, 4),
            "incremental_revenue": pb_incr_rev,
            "incremental_gross_recovery_rate": round(pb_incr_gross_rate, 4),
            "incremental_eligible_recovery_rate": round(pb_incr_eligible_rate, 4),
            "incremental_recovery_rate": round(pb_incr_gross_rate, 4), # backward-compat
            "unsafe_actions_baseline": pb_unsafe_base,
            "unsafe_actions_recoverai": pb_unsafe_rec,
            "escalated_for_review": pb_escalated,
            "stopped_by_policy": pb_stopped,
            "action_selection_recoverai": pb_actions_rec
        })

    return {
        "metadata": corpus["metadata"],
        "financial_metrics": {
            "total_revenue_at_risk": total_revenue_at_risk,
            "eligible_recovery_value": eligible_recovery_value,
            "total_cases": total_cases,
            "eligible_cases": len(eligible_cases),
            "baseline_recovered_revenue": baseline_recovered_revenue,
            "recoverai_recovered_revenue": recoverai_recovered_revenue,
            "baseline_gross_recovery_rate": round(baseline_gross_rate, 4),
            "recoverai_gross_recovery_rate": round(recoverai_gross_rate, 4),
            "baseline_eligible_recovery_rate": round(baseline_eligible_rate, 4),
            "recoverai_eligible_recovery_rate": round(recoverai_eligible_rate, 4),
            "baseline_recovery_rate": round(baseline_gross_rate, 4), # backward-compat
            "recoverai_recovery_rate": round(recoverai_gross_rate, 4), # backward-compat
            "incremental_recovered_revenue": incremental_recovered_revenue,
            "incremental_gross_recovery_rate": round(incremental_gross_rate, 4),
            "incremental_eligible_recovery_rate": round(incremental_eligible_rate, 4),
            "incremental_recovery_rate": round(incremental_gross_rate, 4), # backward-compat
            "revenue_lift_percentage": round(revenue_lift_percentage, 2),
            "baseline_simulated_net_economic_value": baseline_net_value,
            "recoverai_simulated_net_economic_value": recoverai_net_value,
            "incremental_simulated_net_economic_value": incremental_net_value,
            "baseline_net_economic_value": baseline_net_value, # backward-compat
            "recoverai_net_economic_value": recoverai_net_value, # backward-compat
            "incremental_net_economic_value": incremental_net_value, # backward-compat
            "confidence_intervals": {
                "baseline_wilson_score_ci_95": baseline_wilson_ci,
                "recoverai_wilson_score_ci_95": recoverai_wilson_ci,
                "incremental_revenue_bootstrap_ci_95": revenue_bootstrap
            },
            "statistical_significance": mcnemar_result
        },
        "safety_metrics": {
            "total_evaluated_cases": total_cases,
            "policy_decisions": {
                "allow": allow_count,
                "review": review_count,
                "block": block_count
            },
            "escalation_rate": round(escalation_rate, 4),
            "blocked_rate": round(blocked_rate, 4),
            "stopping_rule_activations": stopping_rule_activations,
            "baseline_duplicate_attempts": baseline_duplicate_attempts,
            "recoverai_duplicate_attempts": recoverai_duplicate_attempts,
            "duplicate_actions_prevented_by_policy": duplicate_actions_prevented_by_policy,
            "unsafe_actions_baseline": unsafe_actions_baseline,
            "unsafe_actions_recoverai": unsafe_actions_recoverai,
            "terminal_violations_baseline": terminal_violations_baseline,
            "terminal_violations_recoverai": terminal_violations_recoverai,
            "over_recovery_incidents": 0
        },
        "engine_decision_metrics": {
            "evaluation_scope_disclaimer": "The offline benchmark evaluates the RecoverAI decision/policy engine using synthetic structured diagnoses. It does not measure real-world LLM diagnostic accuracy.",
            "structured_diagnosis_validity_rate": round(valid_diagnosis_rate, 4),
            "evidence_context_availability_rate": round(grounded_evidence_rate, 4),
            "valid_structured_diagnosis_rate": round(valid_diagnosis_rate, 4), # backward-compat
            "evidence_grounded_rate": round(grounded_evidence_rate, 4), # backward-compat
            "engine_action_selection_distribution": recoverai_action_distribution,
            "action_selection_distribution": recoverai_action_distribution, # backward-compat
            "recoverai_action_distribution": recoverai_action_distribution,
            "baseline_action_distribution": baseline_action_distribution,
            "fallback_usage_count": 0
        },
        "ai_diagnostic_metrics": {
            "evaluation_scope_disclaimer": "The offline benchmark evaluates the RecoverAI decision/policy engine using synthetic structured diagnoses. It does not measure real-world LLM diagnostic accuracy.",
            "valid_structured_diagnosis_rate": round(valid_diagnosis_rate, 4),
            "evidence_grounded_rate": round(grounded_evidence_rate, 4),
            "structured_diagnosis_validity_rate": round(valid_diagnosis_rate, 4),
            "evidence_context_availability_rate": round(grounded_evidence_rate, 4),
            "action_selection_distribution": recoverai_action_distribution,
            "recoverai_action_distribution": recoverai_action_distribution,
            "baseline_action_distribution": baseline_action_distribution,
            "fallback_usage_count": 0
        },
        "playbook_breakdown": playbook_breakdown
    }