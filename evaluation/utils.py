"""
RecoverAI Evaluation â€” Mathematical & Statistical Utilities
Provides deterministic SHA-256 hashing, Wilson score confidence intervals,
and paired statistical significance testing (McNemar test & paired bootstrap CI).
"""

import hashlib
import math
import random
from typing import Dict, Any, List, Tuple

def stable_uniform(key: str) -> float:
    """
    Returns a deterministic pseudo-random float in [0.0, 1.0)
    derived from SHA-256 digest of the key string.
    100% reproducible across operating systems, Python versions, and runs.
    """
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    # Use first 16 hex chars (64 bits)
    uint64 = int(digest[:16], 16)
    return uint64 / float(0xFFFFFFFFFFFFFFFF)

def wilson_score_interval(successes: int, total: int, confidence: float = 0.95) -> Dict[str, float]:
    """
    Calculates the authentic Wilson score confidence interval for a binomial proportion.
    Formula: (p + z^2/(2n) +/- z * sqrt((p(1-p) + z^2/(4n))/n)) / (1 + z^2/n)
    """
    if total <= 0:
        return {"rate": 0.0, "lower": 0.0, "upper": 0.0, "margin": 0.0}

    p = successes / float(total)
    # z = 1.95996 for 95% confidence
    z = 1.959963984540054

    denominator = 1.0 + (z * z) / float(total)
    center = (p + (z * z) / (2.0 * float(total))) / denominator
    spread = (z * math.sqrt((p * (1.0 - p) + (z * z) / (4.0 * float(total))) / float(total))) / denominator

    lower = max(0.0, center - spread)
    upper = min(1.0, center + spread)

    return {
        "rate": round(p, 4),
        "lower": round(lower, 4),
        "upper": round(upper, 4),
        "margin": round(upper - p, 4)
    }

def mcnemar_paired_test(recoverai_outcomes: List[bool], baseline_outcomes: List[bool]) -> Dict[str, Any]:
    """
    Performs McNemar's paired test with continuity correction on paired binary outcomes.
    Tests the null hypothesis that Baseline and RecoverAI have marginal homogeneity in recovery rate.

    Contingency table:
      b = RecoverAI recovered (True) AND Baseline failed (False)
      c = RecoverAI failed (False) AND Baseline recovered (True)
    """
    if len(recoverai_outcomes) != len(baseline_outcomes):
        raise ValueError("Outcome arrays must have identical length for paired testing.")

    n = len(recoverai_outcomes)
    a = sum(1 for r, b in zip(recoverai_outcomes, baseline_outcomes) if r and b)     # Both recovered
    b = sum(1 for r, b in zip(recoverai_outcomes, baseline_outcomes) if r and not b) # RecoverAI only
    c = sum(1 for r, b in zip(recoverai_outcomes, baseline_outcomes) if not r and b) # Baseline only
    d = sum(1 for r, b in zip(recoverai_outcomes, baseline_outcomes) if not r and not b) # Both failed

    discordant = b + c
    if discordant == 0:
        return {
            "test_name": "McNemar's Test (Continuity Corrected)",
            "chi2_statistic": 0.0,
            "p_value": 1.0,
            "b_recoverai_only": 0,
            "c_baseline_only": 0,
            "significant_at_p05": False,
            "significant_at_p01": False
        }

    # McNemar's chi-square with Edwards continuity correction: (|b - c| - 1)^2 / (b + c)
    chi2 = ((abs(b - c) - 1.0) ** 2) / float(discordant)

    # Exact p-value for 1 degree of freedom: P(Chi2 >= x) = erfc(sqrt(x / 2))
    p_value = math.erfc(math.sqrt(chi2 / 2.0))

    return {
        "test_name": "McNemar's Test (Continuity Corrected)",
        "chi2_statistic": round(chi2, 4),
        "p_value": p_value,
        "formatted_p_value": f"{p_value:.2e}" if p_value < 0.001 else f"{p_value:.4f}",
        "b_recoverai_only": b,
        "c_baseline_only": c,
        "contingency_table": {"a_both": a, "b_rec_only": b, "c_base_only": c, "d_neither": d},
        "significant_at_p05": p_value < 0.05,
        "significant_at_p01": p_value < 0.01
    }

def paired_bootstrap_revenue_ci(
    recoverai_revenues: List[int],
    baseline_revenues: List[int],
    seed: int = 42,
    n_boot: int = 1000
) -> Dict[str, Any]:
    """
    Computes a deterministic 95% paired bootstrap confidence interval for:
    Delta_Revenue = Sum(RecoverAI) - Sum(Baseline)
    """
    if len(recoverai_revenues) != len(baseline_revenues):
        raise ValueError("Revenue arrays must have identical length for paired bootstrap.")

    n = len(recoverai_revenues)
    differences = [r - b for r, b in zip(recoverai_revenues, baseline_revenues)]
    observed_delta = sum(differences)

    rng = random.Random(seed)
    bootstrap_deltas = []

    for _ in range(n_boot):
        sample = [rng.choice(differences) for _ in range(n)]
        bootstrap_deltas.append(sum(sample))

    bootstrap_deltas.sort()
    # 2.5th and 97.5th percentiles for 95% CI
    low_idx = int(0.025 * n_boot)
    high_idx = int(0.975 * n_boot)

    ci_lower = bootstrap_deltas[low_idx]
    ci_upper = bootstrap_deltas[high_idx]

    return {
        "observed_incremental_revenue": observed_delta,
        "bootstrap_ci_95": {
            "lower": ci_lower,
            "upper": ci_upper
        },
        "n_bootstrap": n_boot,
        "seed": seed
    }
