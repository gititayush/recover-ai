const { environment } = require('../config/env');

class RazorpayApiError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'RazorpayApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function isTestModeKey(keyId) {
  if (!keyId) return false;
  return keyId.trim().startsWith('rzp_test_');
}

function createRazorpayClient({
  keyId = environment.RAZORPAY_KEY_ID,
  keySecret = environment.RAZORPAY_KEY_SECRET,
  baseUrl = 'https://api.razorpay.com/v1'
} = {}) {
  const isConfigured = Boolean(keyId && keySecret);
  const isTestMode = Boolean(keyId && isTestModeKey(keyId));

  return {
    isConfigured,
    isTestMode,
    keyId: keyId || null,

    async createPaymentLink({ amount, currency = 'INR', description, referenceId, expireBy }) {
      if (!keyId || !keySecret) {
        throw new RazorpayApiError('Razorpay API credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured.', 503);
      }

      if (!isTestModeKey(keyId)) {
        throw new RazorpayApiError('Razorpay key is not a Test Mode key (must start with rzp_test_). Execution blocked.', 403);
      }

      const authHeader = `Basic ${Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString('base64')}`;
      const payload = {
        amount: Math.round(amount),
        currency: currency.toUpperCase(),
        accept_partial: false,
        description: description || `Revflow Payment Recovery (${referenceId})`,
        reference_id: referenceId,
        ...(expireBy ? { expire_by: expireBy } : {})
      };

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/payment_links`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const responseData = await response.json().catch(() => null);

        if (!response.ok) {
          const errorMessage = responseData?.error?.description || `Razorpay API returned HTTP ${response.status}.`;
          throw new RazorpayApiError(errorMessage, response.status, responseData);
        }

        if (!responseData || !responseData.id || !responseData.short_url) {
          throw new RazorpayApiError('Razorpay API returned incomplete Payment Link payload.', 502, responseData);
        }

        return {
          id: responseData.id,
          short_url: responseData.short_url,
          status: responseData.status,
          amount: Number(responseData.amount),
          currency: responseData.currency,
          reference_id: responseData.reference_id,
          rawResponse: responseData
        };
      } catch (error) {
        if (error instanceof RazorpayApiError) throw error;
        throw new RazorpayApiError(`Razorpay network or API failure: ${error.message}`, 502);
      }
    },

    async getPaymentLinksByReferenceId(referenceId) {
      if (!keyId || !keySecret) {
        throw new RazorpayApiError('Razorpay API credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured.', 503);
      }

      if (!isTestModeKey(keyId)) {
        throw new RazorpayApiError('Razorpay key is not a Test Mode key (must start with rzp_test_). Execution blocked.', 403);
      }

      const authHeader = `Basic ${Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString('base64')}`;

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/payment_links?reference_id=${encodeURIComponent(referenceId)}`, {
          method: 'GET',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          }
        });

        const responseData = await response.json().catch(() => null);

        if (!response.ok) {
          const errorMessage = responseData?.error?.description || `Razorpay API returned HTTP ${response.status}.`;
          throw new RazorpayApiError(errorMessage, response.status, responseData);
        }

        const items = Array.isArray(responseData?.payment_links) ? responseData.payment_links : [];
        return items
          .filter((item) => !referenceId || item.reference_id === referenceId)
          .map((item) => ({
          id: item.id,
          short_url: item.short_url,
          status: item.status,
          amount: Number(item.amount),
          currency: item.currency,
          reference_id: item.reference_id,
          rawResponse: item
        }));
      } catch (error) {
        if (error instanceof RazorpayApiError) throw error;
        throw new RazorpayApiError(`Razorpay network or API failure: ${error.message}`, 502);
      }
    }
  };
}

module.exports = { createRazorpayClient, RazorpayApiError, isTestModeKey };
