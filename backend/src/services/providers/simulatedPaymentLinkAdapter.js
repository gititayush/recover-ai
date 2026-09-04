/**
 * Revflow V2 — Simulated Payment Link Provider Adapter
 *
 * Implements an isolated, zero-network provider adapter satisfying the
 * paymentLinkExecutor contract for the Recovery Lab ephemeral sandbox.
 *
 * SAFETY INVARIANTS:
 * 1. ZERO NETWORK: Never imports Razorpay SDK or performs HTTP/fetch/axios calls.
 * 2. ZERO PRODUCTION SIDE EFFECTS: Never touches PostgreSQL or live payment rails.
 * 3. SYNTHETIC URLS: Produces non-live, clearly identified synthetic URLs (https://rzp.io/i/lab_*).
 * 4. DETERMINISTIC REPRODUCIBILITY: Returns predictable synthetic IDs derived from referenceId.
 */

class SimulatedPaymentLinkAdapter {
  constructor({ providerName = 'simulated_lab' } = {}) {
    this.isConfigured = true;
    this.isTestMode = true;
    this.providerName = providerName;
    this.createdLinks = new Map();
  }

  /**
   * Generates an ephemeral synthetic payment link result matching Razorpay API contract.
   */
  async createPaymentLink({ amount, currency = 'INR', description, referenceId, expireBy }) {
    if (!referenceId) {
      throw new Error('referenceId is required for simulated payment link creation.');
    }

    const syntheticId = `lab_plink_${referenceId}`;
    const syntheticShortUrl = `https://rzp.io/i/lab_${referenceId}`;
    const roundedAmount = Math.round(Number(amount) || 0);
    const upperCurrency = String(currency || 'INR').toUpperCase();

    const linkRecord = {
      id: syntheticId,
      short_url: syntheticShortUrl,
      status: 'created',
      amount: roundedAmount,
      currency: upperCurrency,
      reference_id: referenceId,
      rawResponse: {
        id: syntheticId,
        entity: 'payment_link',
        status: 'created',
        amount: roundedAmount,
        currency: upperCurrency,
        reference_id: referenceId,
        description: description || `Revflow Lab Payment Recovery (${referenceId})`,
        mode: 'simulated_lab',
        simulated: true,
        expire_by: expireBy || null,
        created_at: Math.floor(Date.now() / 1000)
      }
    };

    this.createdLinks.set(referenceId, linkRecord);
    return linkRecord;
  }

  /**
   * Checks for existing synthetic links by reference ID (idempotency verification).
   */
  async getPaymentLinksByReferenceId(referenceId) {
    const existing = this.createdLinks.get(referenceId);
    return existing ? [existing] : [];
  }
}

module.exports = { SimulatedPaymentLinkAdapter };
