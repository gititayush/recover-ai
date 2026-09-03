/**
 * Revflow V2 — WhatsApp Provider Adapter (Twilio Sandbox / Test Integration)
 *
 * Implements bounded, real external WhatsApp dispatch and callback normalization
 * targeted at the Twilio WhatsApp Sandbox test environment.
 *
 * INVARIANTS:
 * 1. Fails closed if credentials or provider configuration are missing.
 * 2. Never exposes auth tokens or secrets in logs, errors, or action records.
 * 3. Never treats an accepted request (201/queued) as "delivered" or "recovered".
 * 4. Normalizes all provider states and errors into standard Revflow formats.
 */

const crypto = require('crypto');

class WhatsAppProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WhatsAppProviderError';
    this.details = details;
    this.statusCode = details.statusCode || 502;
    this.providerCode = details.code || null;
  }
}

class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderConfigError';
    this.statusCode = 503;
  }
}

class InvalidDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDestinationError';
    this.statusCode = 400;
  }
}

const PROVIDER_STATUSES = Object.freeze({
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  UNDELIVERED: 'UNDELIVERED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Normalizes raw Twilio status string to Revflow provider status.
 */
function normalizeProviderStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'string') return PROVIDER_STATUSES.UNKNOWN;
  const s = rawStatus.trim().toLowerCase();
  switch (s) {
    case 'queued':
    case 'accepted':
    case 'scheduled':
      return PROVIDER_STATUSES.QUEUED;
    case 'sending':
    case 'sent':
      return PROVIDER_STATUSES.SENT;
    case 'delivered':
      return PROVIDER_STATUSES.DELIVERED;
    case 'read':
      return PROVIDER_STATUSES.READ;
    case 'failed':
      return PROVIDER_STATUSES.FAILED;
    case 'undelivered':
      return PROVIDER_STATUSES.UNDELIVERED;
    default:
      return PROVIDER_STATUSES.UNKNOWN;
  }
}

/**
 * Validates and formats a phone number for Twilio WhatsApp (whatsapp:+E164).
 */
function formatWhatsAppDestination(phone) {
  if (!phone || typeof phone !== 'string') {
    throw new InvalidDestinationError('Recipient phone number is required.');
  }

  let cleaned = phone.trim();
  if (cleaned.startsWith('whatsapp:')) {
    cleaned = cleaned.replace('whatsapp:', '');
  }

  // Remove spaces, hyphens, parentheses
  cleaned = cleaned.replace(/[\s\-\(\)]/g, '');

  // If local Indian 10-digit mobile number, prepend +91
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    cleaned = `+91${cleaned}`;
  } else if (/^0[6-9]\d{9}$/.test(cleaned)) {
    cleaned = `+91${cleaned.slice(1)}`;
  } else if (/^[1-9]\d{7,14}$/.test(cleaned)) {
    cleaned = `+${cleaned}`;
  }

  // Must match international E.164 pattern: + followed by 7-15 digits
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
    throw new InvalidDestinationError(
      `Invalid recipient phone '${phone}'. Must be a valid international E.164 number (e.g., +919876543210).`
    );
  }

  return `whatsapp:${cleaned}`;
}

/**
 * Creates an instance of the WhatsApp provider adapter.
 */
function createWhatsAppProvider({
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken = process.env.TWILIO_AUTH_TOKEN,
  from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
  providerMode,
  statusCallbackUrl = process.env.TWILIO_STATUS_CALLBACK_URL || null,
  fetchFn = globalThis.fetch
} = {}) {
  const isConfigured = Boolean(accountSid && authToken && from);
  const resolvedProviderMode = providerMode || (accountSid && authToken ? 'SANDBOX' : (process.env.WHATSAPP_PROVIDER_MODE || 'UNCONFIGURED'));

  return {
    isConfigured: () => isConfigured,
    getProviderMode: () => resolvedProviderMode,
    getSender: () => from,

    /**
     * Sends an outbound WhatsApp message via Twilio Sandbox REST API.
     */
    async sendMessage({
      to,
      message,
      body,
      statusCallback = statusCallbackUrl,
      timeoutMs = 10000
    }) {
      if (!isConfigured) {
        throw new ProviderConfigError(
          'Twilio WhatsApp Sandbox credentials are not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.'
        );
      }

      if (resolvedProviderMode !== 'SANDBOX' && resolvedProviderMode !== 'TEST') {
        throw new ProviderConfigError(
          `Outbound WhatsApp sends are prohibited in providerMode '${resolvedProviderMode}'. Mode must be 'SANDBOX' or 'TEST'.`
        );
      }

      const formattedTo = formatWhatsAppDestination(to);
      const formattedFrom = formatWhatsAppDestination(from);
      const messageContent = body || message;

      if (!messageContent || typeof messageContent !== 'string' || messageContent.trim().length === 0) {
        throw new WhatsAppProviderError('Message content cannot be empty.', { statusCode: 400 });
      }

      const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('From', from);
      params.append('To', formattedTo);
      params.append('Body', messageContent.trim());
      if (statusCallback) {
        params.append('StatusCallback', statusCallback);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchFn(apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString(),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        let data;
        try {
          data = await response.json();
        } catch {
          throw new WhatsAppProviderError(
            `Twilio returned malformed non-JSON response with HTTP status ${response.status}.`,
            { statusCode: 502 }
          );
        }

        if (!response.ok) {
          const errCode = data?.code || null;
          const errMsg = data?.message || response.statusText;

          if (response.status === 400) {
            throw new WhatsAppProviderError(`Twilio Bad Request (code ${errCode}): ${errMsg}`, {
              statusCode: 400,
              code: errCode
            });
          }
          if (response.status === 401 || response.status === 403) {
            throw new WhatsAppProviderError('Twilio Authentication / Permission Failed.', {
              statusCode: response.status,
              code: errCode
            });
          }
          if (response.status === 429) {
            throw new WhatsAppProviderError('Twilio API Rate Limit Exceeded.', {
              statusCode: 429,
              code: errCode
            });
          }
          throw new WhatsAppProviderError(`Twilio Error (${response.status}): ${errMsg}`, {
            statusCode: response.status >= 500 ? 502 : response.status,
            code: errCode
          });
        }

        if (!data || !data.sid) {
          throw new WhatsAppProviderError('Twilio response missing required message SID.', { statusCode: 502 });
        }

        return {
          providerMessageId: data.sid,
          provider: 'twilio_sandbox',
          status: normalizeProviderStatus(data.status),
          to: data.to || formattedTo,
          from: data.from || from,
          dateCreated: data.date_created || new Date().toISOString(),
          rawResponse: {
            sid: data.sid,
            status: data.status,
            errorCode: data.error_code || null,
            errorMessage: data.error_message || null
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof WhatsAppProviderError || error instanceof ProviderConfigError || error instanceof InvalidDestinationError) {
          throw error;
        }
        if (error.name === 'AbortError') {
          throw new WhatsAppProviderError(`Twilio WhatsApp request timed out after ${timeoutMs}ms.`, { statusCode: 504 });
        }
        throw new WhatsAppProviderError(`Twilio connection failure: ${error.message}`, { statusCode: 502 });
      }
    },

    /**
     * Verifies the authenticity of a Twilio status webhook signature.
     * Follows Twilio's standard HMAC-SHA1 validation.
     */
    verifySignature(signatureHeader, fullUrl, postParams = {}) {
      if (!authToken) return false;
      if (!signatureHeader || !fullUrl) return false;

      // Sort params alphabetically by key and concatenate key + value
      const sortedKeys = Object.keys(postParams).sort();
      let dataString = fullUrl;
      for (const key of sortedKeys) {
        dataString += key + postParams[key];
      }

      const expectedSignature = crypto
        .createHmac('sha1', authToken)
        .update(Buffer.from(dataString, 'utf-8'))
        .digest('base64');

      try {
        return crypto.timingSafeEqual(
          Buffer.from(signatureHeader, 'utf-8'),
          Buffer.from(expectedSignature, 'utf-8')
        );
      } catch {
        return false;
      }
    }
  };
}

function WhatsAppProvider(options = {}) {
  return createWhatsAppProvider(options);
}

module.exports = {
  WhatsAppProvider,
  createWhatsAppProvider,
  normalizeProviderStatus,
  formatWhatsAppDestination,
  PROVIDER_STATUSES,
  WHATSAPP_STATUSES: PROVIDER_STATUSES,
  WhatsAppProviderError,
  ProviderConfigError,
  InvalidDestinationError
};
