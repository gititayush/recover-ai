/**
 * Revflow V2 — Customer Communication & WhatsApp Controller
 *
 * Coordinates fact-grounded message rendering, language selection,
 * pre-send policy verification, outbound dispatch via Twilio Sandbox
 * (or bounded simulation), and provider delivery status callbacks.
 *
 * INVARIANTS:
 * 1. AI PROPOSES. POLICY DECIDES. EXECUTOR ACTS.
 * 2. Client CANNOT inject arbitrary amounts, status, or URLs.
 * 3. Message delivery !== revenue recovery.
 * 4. Fails closed with non-overridable policy blocks and stopping criteria.
 */

const {
  selectLanguage,
  buildCommunicationPayload,
  CommunicationGroundingError,
  UnsupportedLanguageError,
  SUPPORTED_LANGUAGES
} = require('../services/communicationService');
const { evaluateStoppingCriteria, STOP_REASON_CODES } = require('../policy/stoppingEngine');
const { evaluatePolicy } = require('../policy/policyEngine');
const { normalizeProviderStatus, PROVIDER_STATUSES } = require('../services/providers/whatsappProvider');
const { environment } = require('../config/env');

const STATUS_PROGRESSION_RANK = Object.freeze({
  UNKNOWN: 0,
  QUEUED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
  UNDELIVERED: 5
});

function createCommunicationController(repository, whatsappProvider) {
  return {
    /**
     * Preview endpoint: Dry-run message rendering with grounded fact breakdown.
     * NEVER contacts external providers and NEVER mutates state.
     */
    preview: async (request, response, next) => {
      try {
        const caseId = request.params.id;
        const detail = await repository.getCaseDetail(caseId);
        if (!detail) {
          return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        }

        const channel = (request.body.channel || 'whatsapp').toLowerCase();
        if (channel !== 'whatsapp') {
          return response.status(400).json({
            error: 'UNSUPPORTED_CHANNEL',
            message: `Unsupported communication channel '${channel}'. Only 'whatsapp' is supported.`
          });
        }

        const requestedLanguage = request.body.language || null;
        if (requestedLanguage && !SUPPORTED_LANGUAGES.includes(requestedLanguage.toLowerCase())) {
          return response.status(400).json({
            error: 'UNSUPPORTED_LANGUAGE',
            message: `Unsupported language '${requestedLanguage}'. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}.`
          });
        }

        // Locate existing payment link if available
        const existingActions = await repository.findActionsByCaseId(detail.recoveryCase.id);
        const paymentLinkAction = existingActions.find(
          (a) => a.actionType === 'CREATE_PAYMENT_LINK' && a.paymentLinkUrl && ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status)
        );

        // Fetch latest diagnosis if available
        const diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);

        // Determine customer name if present in raw payload or case
        const lastEvent = detail.events?.at(-1);
        const customerName = lastEvent?.rawPayload?.customerName
          || lastEvent?.rawPayload?.customer?.name
          || detail.recoveryCase.customerName
          || null;

        // Build fact-grounded communication payload
        const payload = buildCommunicationPayload({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          action: paymentLinkAction,
          customerName,
          languagePreference: requestedLanguage
        });

        // Evaluate stopping criteria for advisory visibility
        const stopping = evaluateStoppingCriteria({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: 'CUSTOMER_OUTREACH',
          events: detail.events,
          existingActions,
          now: () => new Date()
        });

        // Evaluate policy for advisory visibility
        const policyDecision = evaluatePolicy({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: 'CUSTOMER_OUTREACH',
          events: detail.events,
          existingActions,
          allowSimulated: true,
          now: () => new Date()
        });

        return response.json({
          channel: payload.channel,
          language: payload.language,
          selectionReason: payload.selectionReason,
          message: payload.message,
          amountFormatted: payload.amountFormatted,
          customerName: payload.customerName,
          paymentLinkUrl: payload.paymentLinkUrl,
          factsUsed: payload.factsUsed,
          groundingValid: true,
          providerConfigured: whatsappProvider?.isConfigured() || false,
          providerMode: whatsappProvider?.getProviderMode() || 'UNCONFIGURED',
          policyDecision: policyDecision.decision,
          policyReasons: policyDecision.reasons,
          stoppingEvaluation: {
            stopped: stopping.stopped,
            actionDisposition: stopping.actionDisposition,
            reasonCode: stopping.reasonCode,
            humanReadableReason: stopping.humanReadableReason
          }
        });
      } catch (error) {
        if (error instanceof CommunicationGroundingError || error instanceof UnsupportedLanguageError) {
          return response.status(error.statusCode || 422).json({
            error: error.name,
            message: error.message,
            details: error.details
          });
        }
        return next(error);
      }
    },

    /**
     * Send endpoint: Strictly validated dispatch via Twilio Sandbox or bounded simulation.
     */
    send: async (request, response, next) => {
      try {
        const caseId = request.params.id;
        const detail = await repository.getCaseDetail(caseId);
        if (!detail) {
          return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        }

        const channel = (request.body.channel || 'whatsapp').toLowerCase();
        if (channel !== 'whatsapp') {
          return response.status(400).json({
            error: 'UNSUPPORTED_CHANNEL',
            message: `Unsupported communication channel '${channel}'. Only 'whatsapp' is supported.`
          });
        }

        const requestedLanguage = request.body.language || null;
        if (requestedLanguage && !SUPPORTED_LANGUAGES.includes(requestedLanguage.toLowerCase())) {
          return response.status(400).json({
            error: 'UNSUPPORTED_LANGUAGE',
            message: `Unsupported language '${requestedLanguage}'. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}.`
          });
        }

        const existingActions = await repository.findActionsByCaseId(detail.recoveryCase.id);
        const diagnosis = await repository.findDiagnosisByCaseId(detail.recoveryCase.id);

        // 1. TOCTOU Revalidation: Authoritative Stopping Criteria Check
        const stopping = evaluateStoppingCriteria({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: 'CUSTOMER_OUTREACH',
          events: detail.events,
          existingActions,
          now: () => new Date()
        });

        if (stopping.stopped && stopping.actionDisposition === 'HARD_STOP') {
          return response.status(422).json({
            error: 'EXECUTION_STOPPED',
            message: stopping.humanReadableReason,
            reasonCode: stopping.reasonCode,
            actionDisposition: stopping.actionDisposition
          });
        }

        // 2. Authoritative Policy Engine Check
        const policyDecision = evaluatePolicy({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          candidateAction: 'CUSTOMER_OUTREACH',
          events: detail.events,
          existingActions,
          allowSimulated: true,
          now: () => new Date()
        });

        if (policyDecision.decision === 'BLOCK') {
          return response.status(422).json({
            error: 'POLICY_BLOCKED',
            message: 'Customer outreach is blocked by deterministic safety guardrails.',
            reasons: policyDecision.reasons
          });
        }

        if (policyDecision.decision === 'REVIEW' && detail.recoveryCase.escalationStatus !== 'APPROVED') {
          return response.status(422).json({
            error: 'REVIEW_REQUIRED',
            message: 'Customer outreach requires human operations approval before dispatch.',
            reasons: policyDecision.reasons
          });
        }

        // 3. Frequency Capping & Outreach Attempt Limit (Configurable Merchant Policy Defaults)
        const maxOutreachAttempts = environment.COMMUNICATION_MAX_ATTEMPTS || 2;
        const cooldownMinutes = environment.COMMUNICATION_COOLDOWN_MINUTES || 30;

        const commActions = existingActions.filter(
          (a) => a.actionType === 'CUSTOMER_OUTREACH' || a.actionType === 'DISPATCH_VERNACULAR_ASSIST'
        );

        if (commActions.length >= maxOutreachAttempts) {
          return response.status(422).json({
            error: 'MAX_OUTREACH_EXCEEDED',
            message: `Outreach attempt limit (${maxOutreachAttempts}) reached for this recovery case.`
          });
        }

        const lastCommAction = commActions.at(-1);
        if (lastCommAction && lastCommAction.createdAt) {
          const elapsedMinutes = Math.floor((Date.now() - new Date(lastCommAction.createdAt).getTime()) / 60000);
          if (elapsedMinutes < cooldownMinutes) {
            return response.status(422).json({
              error: 'COOLDOWN_ACTIVE',
              message: `Outreach cooldown is active (${elapsedMinutes}/${cooldownMinutes} min elapsed). Please wait before contacting again.`
            });
          }
        }

        // 4. Derive Verified Parameters (Client cannot tamper)
        const paymentLinkAction = existingActions.find(
          (a) => a.actionType === 'CREATE_PAYMENT_LINK' && a.paymentLinkUrl && ['EXECUTED', 'OUTCOME_CONFIRMED'].includes(a.status)
        );

        const lastEvent = detail.events?.at(-1);
        const customerName = lastEvent?.rawPayload?.customerName
          || lastEvent?.rawPayload?.customer?.name
          || detail.recoveryCase.customerName
          || null;

        // 5. Render Message Copy & Validate Grounding
        const payload = buildCommunicationPayload({
          recoveryCase: detail.recoveryCase,
          diagnosis,
          action: paymentLinkAction,
          customerName,
          languagePreference: requestedLanguage
        });

        // 6. Resolve Destination Phone Number
        const recipientPhone = request.body.recipientPhone
          || lastEvent?.rawPayload?.customerPhone
          || detail.recoveryCase.customerReference
          || '+919876543210';

        // 7. Dispatch via Provider or Bounded Simulation
        const isProviderReady = whatsappProvider
          && typeof whatsappProvider.isConfigured === 'function'
          && whatsappProvider.isConfigured()
          && (whatsappProvider.getProviderMode() === 'SANDBOX' || whatsappProvider.getProviderMode() === 'TEST');

        const attemptNumber = commActions.length + 1;
        let createdAction;

        if (isProviderReady) {
          // Live Dispatch to Twilio WhatsApp Sandbox
          const sendResult = await whatsappProvider.sendMessage({
            to: recipientPhone,
            message: payload.message
          });

          createdAction = await repository.createAction({
            recoveryCaseId: detail.recoveryCase.id,
            actionType: 'CUSTOMER_OUTREACH',
            status: 'EXECUTED',
            policyDecision: 'ALLOW',
            policyVersion: policyDecision.policyVersion,
            idempotencyKey: `comm_${detail.recoveryCase.id}_whatsapp_v${attemptNumber}`,
            provider: 'twilio_sandbox',
            providerActionId: sendResult.providerMessageId,
            amount: detail.recoveryCase.amount,
            currency: detail.recoveryCase.currency,
            requestMetadata: {
              communication: {
                channel: 'whatsapp',
                language: payload.language,
                selectionReason: payload.selectionReason,
                message: payload.message,
                provider: 'twilio_sandbox',
                providerMessageId: sendResult.providerMessageId,
                status: sendResult.status,
                recipient: recipientPhone,
                factsUsed: payload.factsUsed,
                groundingValid: true,
                provenance: 'WHATSAPP_TEST_PROVIDER'
              }
            },
            responseMetadata: {
              provider: 'twilio_sandbox',
              providerMessageId: sendResult.providerMessageId,
              initialStatus: sendResult.status,
              externalApiCalled: true,
              recoveredAmount: 0,
              notice: 'Dispatched via Twilio WhatsApp Sandbox. Message delivery !== revenue recovery.'
            }
          });
        } else {
          // Bounded Simulation
          const simId = `sim_msg_${detail.recoveryCase.id}_v${attemptNumber}`;
          createdAction = await repository.createAction({
            recoveryCaseId: detail.recoveryCase.id,
            actionType: 'CUSTOMER_OUTREACH',
            status: 'EXECUTED',
            policyDecision: 'ALLOW',
            policyVersion: policyDecision.policyVersion,
            idempotencyKey: `comm_${detail.recoveryCase.id}_simulated_v${attemptNumber}`,
            provider: 'simulated',
            providerActionId: simId,
            amount: detail.recoveryCase.amount,
            currency: detail.recoveryCase.currency,
            requestMetadata: {
              communication: {
                channel: 'whatsapp',
                language: payload.language,
                selectionReason: payload.selectionReason,
                message: payload.message,
                provider: 'simulated',
                providerMessageId: simId,
                status: 'SENT',
                recipient: recipientPhone,
                factsUsed: payload.factsUsed,
                groundingValid: true,
                provenance: 'SIMULATED'
              }
            },
            responseMetadata: {
              provider: 'simulated',
              isSimulated: true,
              externalApiCalled: false,
              recoveredAmount: 0,
              notice: 'Simulated WhatsApp outreach executed. No external messaging provider was called.'
            }
          });
        }

        // 8. Record Audit Log
        await repository.addAudit(
          detail.recoveryCase.id,
          'COMMUNICATION_DISPATCHED',
          `Customer outreach dispatched via ${createdAction.provider} (${payload.language.toUpperCase()})`,
          {
            actionId: createdAction.id,
            provider: createdAction.provider,
            channel: 'whatsapp',
            language: payload.language,
            isSimulated: createdAction.provider === 'simulated'
          }
        );

        return response.status(201).json({
          action: createdAction,
          communication: createdAction.requestMetadata.communication,
          provenance: createdAction.requestMetadata.communication.provenance
        });
      } catch (error) {
        if (error instanceof CommunicationGroundingError || error instanceof UnsupportedLanguageError) {
          return response.status(error.statusCode || 422).json({
            error: error.name,
            message: error.message,
            details: error.details
          });
        }
        return next(error);
      }
    },

    /**
     * Webhook status callback: Handles delivery receipts from Twilio WhatsApp Sandbox.
     * Correlates MessageSid, normalizes status, records audit event.
     * NEVER marks case resolved or credits revenue.
     */
    handleWebhook: async (request, response, next) => {
      try {
        // Optional Twilio HMAC-SHA1 signature verification
        const signatureHeader = request.headers['x-twilio-signature'];
        if (signatureHeader && whatsappProvider && typeof whatsappProvider.verifySignature === 'function') {
          const fullUrl = `${request.protocol}://${request.get('host')}${request.originalUrl}`;
          const isValid = whatsappProvider.verifySignature(signatureHeader, fullUrl, request.body);
          if (!isValid) {
            return response.status(403).json({
              error: 'INVALID_SIGNATURE',
              message: 'Twilio WhatsApp webhook signature verification failed.'
            });
          }
        }

        const body = request.body || {};
        const messageSid = body.MessageSid || body.messageSid;
        const rawStatus = body.MessageStatus || body.messageStatus;

        if (!messageSid) {
          return response.status(400).json({
            error: 'MISSING_MESSAGE_SID',
            message: 'Webhook payload missing required MessageSid.'
          });
        }

        if (!rawStatus) {
          return response.status(400).json({
            error: 'MISSING_MESSAGE_STATUS',
            message: 'Webhook payload missing required MessageStatus.'
          });
        }

        const normalizedStatus = normalizeProviderStatus(rawStatus);

        // Correlate messageSid to existing recovery action
        let action = null;
        if (typeof repository.findActionByProviderActionId === 'function') {
          action = await repository.findActionByProviderActionId(messageSid);
        }

        if (!action && typeof repository.findActionByPaymentLinkId === 'function') {
          action = await repository.findActionByPaymentLinkId(messageSid);
        }

        if (!action && typeof repository.getAllActions === 'function') {
          const all = await repository.getAllActions();
          action = all.find(
            (a) => a.providerActionId === messageSid || a.requestMetadata?.communication?.providerMessageId === messageSid
          );
        }

        if (!action) {
          return response.status(200).json({
            received: true,
            matched: false,
            messageSid,
            warning: 'No matching recovery action found for MessageSid.',
            notice: 'Webhook received but no corresponding Revflow action matched.'
          });
        }

        // Deduplication: if status identical, acknowledge without redundant mutation
        const currentStatus = action.requestMetadata?.communication?.status || PROVIDER_STATUSES.UNKNOWN;
        if (currentStatus === normalizedStatus) {
          return response.status(200).json({
            received: true,
            duplicate: true,
            deduplicated: true,
            messageSid,
            status: normalizedStatus
          });
        }

        // Out-of-order protection: Do not downgrade progression rank (e.g. from READ to DELIVERED)
        const currentRank = STATUS_PROGRESSION_RANK[currentStatus] || 0;
        const incomingRank = STATUS_PROGRESSION_RANK[normalizedStatus] || 0;

        if (incomingRank < currentRank && currentStatus !== PROVIDER_STATUSES.FAILED) {
          return response.status(200).json({
            received: true,
            droppedReason: 'OUT_OF_ORDER',
            ignoredOutOfOrder: true,
            currentStatus,
            incomingStatus: normalizedStatus
          });
        }

        // Update action metadata
        const updatedRequestMeta = {
          ...action.requestMetadata,
          communication: {
            ...action.requestMetadata?.communication,
            status: normalizedStatus,
            lastStatusUpdateAt: new Date().toISOString()
          }
        };

        const updatedResponseMeta = {
          ...action.responseMetadata,
          lastProviderStatus: normalizedStatus,
          statusUpdatedAt: new Date().toISOString(),
          providerErrorCode: body.ErrorCode || null,
          providerErrorMessage: body.ErrorMessage || null
        };

        const isFailed = normalizedStatus === PROVIDER_STATUSES.FAILED || normalizedStatus === PROVIDER_STATUSES.UNDELIVERED;
        const newStatus = isFailed ? 'FAILED' : action.status;

        await repository.updateAction(action.id, {
          status: newStatus,
          requestMetadata: updatedRequestMeta,
          responseMetadata: updatedResponseMeta
        });

        // Record audit event
        await repository.addAudit(
          action.recoveryCaseId,
          'COMMUNICATION_STATUS_UPDATED',
          `WhatsApp message ${messageSid} delivery status transitioned to ${normalizedStatus}`,
          {
            actionId: action.id,
            messageSid,
            status: normalizedStatus,
            previousStatus: currentStatus,
            errorCode: body.ErrorCode || null
          }
        );

        return response.status(200).json({
          received: true,
          messageSid,
          status: normalizedStatus,
          actionId: action.id
        });
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = { createCommunicationController };
