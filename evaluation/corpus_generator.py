"""
RecoverAI Evaluation — Seeded Stratified Corpus Generator
Generates reproducible, multi-playbook failure scenarios across all 7 Track 03 directions.
"""

import json
import random
from pathlib import Path

PLAYBOOKS = [
    {
        "id": "payment_degradation",
        "name": "Payment Degradation & Root Cause Recovery",
        "domain": "Core Gateway / E-Commerce Checkout",
        "causes": [
            "Acquiring bank timeout during HDFC 3D-Secure challenge",
            "SBI netbanking gateway unresponsive during peak traffic",
            "Payment gateway network packet loss on card authorization",
            "Temporary acquirer degradation during OTP verification",
            "ICICI bank authorization timeout on credit card"
        ],
        "merchants": ["QuickCart Retail", "NovaGadgets Store", "ZippyMart India"],
        "base_amount_range": (80000, 2800000), # ₹800 to ₹28,000
        "high_value_ratio": 0.25
    },
    {
        "id": "checkout_drop_off",
        "name": "Checkout Drop-off Recovery",
        "domain": "High-Intent Cart Abandonment",
        "causes": [
            "Customer dropped off at OTP screen after network hesitation",
            "Multi-step checkout session timed out on mobile Safari",
            "Customer abandoned cart after 3D-Secure auth delay",
            "Client-side payment modal closed before confirmation"
        ],
        "merchants": ["UrbanTrends Apparel", "LuxeDecor Living", "FitPulse Gear"],
        "base_amount_range": (50000, 2200000), # ₹500 to ₹22,000
        "high_value_ratio": 0.20
    },
    {
        "id": "failed_subscription",
        "name": "Failed-Subscription Recovery (Smart Dunning)",
        "domain": "SaaS & Recurring Billing",
        "causes": [
            "Recurring mandate declined due to token expiration",
            "Temporary insufficient balance on auto-debit charge date",
            "Card issuing bank recurring debit limit exceeded",
            "Customer credit card replaced by bank"
        ],
        "merchants": ["CloudScale SaaS", "StreamHub Prime", "DataSync Pro"],
        "base_amount_range": (99900, 4500000), # ₹999 to ₹45,000
        "high_value_ratio": 0.35
    },
    {
        "id": "b2b_receivables",
        "name": "B2B Receivables Chaser",
        "domain": "Wholesale & Invoicing",
        "causes": [
            "Corporate accounts payable workflow pending finance controller sign-off",
            "Net-30 corporate invoice overdue by 14 days",
            "Quarterly supplier invoice payment pending verification",
            "Procurement department batch clearance scheduled for next week"
        ],
        "merchants": ["Apex Logistics Supplies", "Zenith Raw Materials", "Vortex Industrial Parts"],
        "base_amount_range": (2000000, 8500000), # ₹20,000 to ₹85,000
        "high_value_ratio": 0.65
    },
    {
        "id": "mandate_retry",
        "name": "Mandate Retry Sequencer",
        "domain": "UPI Autopay & e-Mandates",
        "causes": [
            "Monthly SIP mandate failed: NPCI server timeout on 31st",
            "UPI Autopay debit failed: Salary not credited prior to 1st",
            "Auto-debit mandate timeout during bank month-end batch",
            "EMI installment debit failed on Axis bank account"
        ],
        "merchants": ["FinGrowth Mutual Funds", "EasyEMI Credit", "WealthPulse Capital"],
        "base_amount_range": (100000, 3500000), # ₹1,000 to ₹35,000
        "high_value_ratio": 0.30
    },
    {
        "id": "hinglish_voice_recovery",
        "name": "Hinglish Voice Recovery",
        "domain": "Tier-2/Tier-3 Vernacular Commerce",
        "causes": [
            "Customer confused by English-only banking authorization page",
            "Incorrect UPI PIN entered twice due to interface ambiguity",
            "Customer dropped off converting COD order to prepaid UPI discount",
            "OTP verification failure due to language difficulty"
        ],
        "merchants": ["DesiBazaar Crafts", "GraminKart Electronics", "BharatMart Wholesale"],
        "base_amount_range": (49900, 1800000), # ₹499 to ₹18,000
        "high_value_ratio": 0.15
    },
    {
        "id": "promise_to_pay",
        "name": "Promise-to-Pay Tracker",
        "domain": "Collections & Delayed Commitments",
        "causes": [
            "Customer committed to pay course fee installment on upcoming 5th",
            "Customer requested 3-day grace period following hospitalization",
            "Delayed invoice settlement agreed for Friday payday",
            "Customer promised settlement after client funds release"
        ],
        "merchants": ["EduMaster Academy", "CarePlus Health Plans", "BuildRight Projects"],
        "base_amount_range": (150000, 4800000), # ₹1,500 to ₹48,000
        "high_value_ratio": 0.40
    }
]

CUSTOMERS = [
    "Pooja Sharma", "Rahul Verma", "Ananya Sen", "Amit Patel", "Suresh Kumar",
    "Priyanka Reddy", "Vikram Malhotra", "Kavita Nair", "Rohit Joshi", "Sneha Gupta",
    "Deepak Choudhary", "Ritu Singhania", "Manoj Tiwari", "Swati Deshmukh", "Arjun Kapoor"
]

def generate_stratified_corpus(seed: int = 42, cases_per_playbook: int = 80) -> dict:
    random.seed(seed)
    total_cases = cases_per_playbook * len(PLAYBOOKS)
    cases = []

    case_counter = 1
    for pb in PLAYBOOKS:
        for _ in range(cases_per_playbook):
            is_high_value = random.random() < pb["high_value_ratio"]
            if is_high_value:
                # ₹25,000 to ₹95,000 (paise: 2,500,000 to 9,500,000)
                amount = random.randint(2500000, 9500000)
            else:
                low_p, high_p = pb["base_amount_range"]
                amount = random.randint(low_p, min(high_p, 2490000))

            # Round amount to clean hundreds (e.g. ₹4,999.00 -> 499900 paise)
            amount = (amount // 10000) * 10000 + (9900 if amount < 2500000 else 0)

            # Terminal / Refund states: ~6% of cases are cancelled or refunded
            is_cancelled = random.random() < 0.04
            is_refunded = (not is_cancelled) and (random.random() < 0.03)

            # Historical attempts & timing
            attempt_count = random.choices([1, 2, 3, 4], weights=[0.55, 0.25, 0.15, 0.05])[0]
            time_since_failure = random.randint(3, 180)
            cooldown_active = time_since_failure < 30 and attempt_count > 1

            # True underlying recovery conversion probability if safely intervened
            # (Higher for transient downtime & intent; lower for chronic insufficient funds)
            if pb["id"] == "payment_degradation":
                true_conversion_propensity = random.uniform(0.60, 0.85)
            elif pb["id"] == "checkout_drop_off":
                true_conversion_propensity = random.uniform(0.45, 0.70)
            elif pb["id"] == "failed_subscription":
                true_conversion_propensity = random.uniform(0.40, 0.65)
            elif pb["id"] == "b2b_receivables":
                true_conversion_propensity = random.uniform(0.50, 0.80)
            elif pb["id"] == "mandate_retry":
                true_conversion_propensity = random.uniform(0.50, 0.75)
            elif pb["id"] == "hinglish_voice_recovery":
                true_conversion_propensity = random.uniform(0.45, 0.72)
            else: # promise_to_pay
                true_conversion_propensity = random.uniform(0.55, 0.80)

            case = {
                "case_id": f"case_{pb['id'][:3]}_{case_counter:04d}",
                "playbook_id": pb["id"],
                "playbook_name": pb["name"],
                "domain": pb["domain"],
                "merchant_name": random.choice(pb["merchants"]),
                "customer_name": random.choice(CUSTOMERS),
                "payment_id": f"pay_eval_{case_counter:05d}",
                "order_id": f"order_eval_{case_counter:05d}",
                "amount": amount,
                "currency": "INR",
                "failure_reason": random.choice(pb["causes"]),
                "attempt_count": attempt_count,
                "time_since_failure_minutes": time_since_failure,
                "cooldown_active": cooldown_active,
                "is_cancelled": is_cancelled,
                "is_refunded": is_refunded,
                "is_terminal": is_cancelled or is_refunded,
                "true_conversion_propensity": round(true_conversion_propensity, 4)
            }
            cases.append(case)
            case_counter += 1

    metadata = {
        "seed": seed,
        "total_cases": total_cases,
        "cases_per_playbook": cases_per_playbook,
        "playbook_count": len(PLAYBOOKS),
        "generator_version": "corpus-v1-stratified",
        "description": "Stratified multi-playbook evaluation corpus across all 7 Track 03 directions."
    }

    return {"metadata": metadata, "cases": cases}

if __name__ == "__main__":
    corpus_data = generate_stratified_corpus(seed=42, cases_per_playbook=80)
    out_path = Path("evaluation/data/corpus_seed42_560.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(corpus_data, f, indent=2)
    print(f"Generated {len(corpus_data['cases'])} cases across {len(PLAYBOOKS)} playbooks -> {out_path}")