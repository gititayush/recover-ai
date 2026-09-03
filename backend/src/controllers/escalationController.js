/**
 * Revflow V2 — Escalation Controller
 *
 * Implements human approval and rejection endpoints for policy REVIEW outcomes.
 *
 * NON-NEGOTIABLE INVARIANT:
 * Human approval MAY resolve a REVIEW condition.
 * Human approval MUST NEVER override a HARD BLOCK.
 */

const { evaluatePolicy } = require('../policy/policyEngine');

function createEscalationController(repository, { diagnosisService = null, razorpayClient = null } = {}) {
  return {
    approve: async (req, res, next) => {
      try {
        const caseId = Number(req.params.id);
        const { reviewer, notes } = req.body || {};

        if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
          return res.status(400).json({
            error: 'MISSING_REVIEWER',
            message: 'Reviewer identity is required for escalation approval.'
          });
        }

        const detail = await repository.getCaseDetail(caseId);
        if (!detail) {
          return res.status(404).json({
            error: 'CASE_NOT_FOUND',
            message: `Recovery case ${caseId} not found.`
          });
        }

        const recoveryCase = detail.recoveryCase;

        if (recoveryCase.escalationStatus === 'REJECTED') {
          return res.status(409).json({
            error: 'CASE_ALREADY_REJECTED',
            message: 'Case was explicitly rejected by operations and cannot be approved.',
            case: recoveryCase
          });
        }

        if (recoveryCase.escalationStatus === 'APPROVED') {
          return res.status(200).json({
            success: true,
            alreadyApproved: true,
            message: 'Case is already approved.',
            case: recoveryCase,
            escalation: {
              status: 'APPROVED',
              approvedBy: recoveryCase.approvedBy,
              approvedAt: recoveryCase.approvedAt,
              notes: recoveryCase.reviewNotes
            }
          });
        }

        // Authoritative current state inspection: Load diagnosis, events, actions
        let diagnosis = await repository.findDiagnosisByCaseId(recoveryCase.id);
        if (!diagnosis && diagnosisService) {
          try {
            const diagResult = await diagnosisService.diagnose(detail);
            diagnosis = await repository.createDiagnosis({
              recoveryCaseId: recoveryCase.id,
              ...diagResult
            });
          } catch (diagErr) {
            // Diagnostic fallback if service unavailable
          }
        }

        const isTestMode = razorpayClient?.isTestMode !== undefined ? razorpayClient.isTestMode : true;

        // Re-run policy WITHOUT approval first to verify current ground-truth disposition
        const rawPolicy = evaluatePolicy({
          recoveryCase,
          diagnosis,
          candidateAction: req.body?.action || diagnosis?.recommendation?.action || 'CREATE_PAYMENT_LINK',
          events: detail.events,
          existingActions: detail.actions,
          isTestMode
        });

        // NON-NEGOTIABLE INVARIANT: Human approval MUST NEVER override a HARD BLOCK
        if (rawPolicy.decision === 'BLOCK') {
          await repository.addAudit(
            recoveryCase.id,
            'ACTION_BLOCKED',
            `Attempted human approval rejected: Case is blocked by policy: ${rawPolicy.reasons.join('; ')}`,
            { attemptedBy: reviewer.trim(), blockReasons: rawPolicy.reasons }
          );

          return res.status(422).json({
            error: 'BLOCK_CANNOT_BE_APPROVED',
            message: 'Human approval cannot override hard BLOCK conditions.',
            blockReasons: rawPolicy.reasons,
            policyDecision: rawPolicy
          });
        }

        // Re-run policy WITH human approval
        const approvedAt = new Date().toISOString();
        const policyWithApproval = evaluatePolicy({
          recoveryCase,
          diagnosis,
          candidateAction: req.body?.action || diagnosis?.recommendation?.action || 'CREATE_PAYMENT_LINK',
          events: detail.events,
          existingActions: detail.actions,
          isTestMode,
          humanApproval: {
            approvedBy: reviewer.trim(),
            approvedAt,
            notes: notes?.trim() || null
          }
        });

        if (policyWithApproval.decision !== 'ALLOW') {
          return res.status(422).json({
            error: 'APPROVAL_RECHECK_FAILED',
            message: 'Re-evaluation with human approval did not yield an ALLOW decision.',
            policyDecision: policyWithApproval
          });
        }

        // Update case record with APPROVED status
        const updatedCase = await repository.updateCase(recoveryCase.id, {
          escalationStatus: 'APPROVED',
          approvedBy: reviewer.trim(),
          approvedAt,
          reviewNotes: notes?.trim() || null,
          lastEventAt: approvedAt
        });

        await repository.addAudit(
          recoveryCase.id,
          'ESCALATION_APPROVED',
          `Human approval granted by ${reviewer.trim()}: ${notes?.trim() || 'No notes provided.'}`,
          {
            reviewer: reviewer.trim(),
            notes: notes?.trim() || null,
            overriddenReviewReasons: rawPolicy.reasons,
            policyDecision: policyWithApproval
          }
        );

        return res.status(200).json({
          success: true,
          case: updatedCase,
          escalation: {
            status: 'APPROVED',
            approvedBy: reviewer.trim(),
            approvedAt,
            notes: notes?.trim() || null
          },
          policyDecision: policyWithApproval,
          executionEligible: true,
          message: 'Human approval granted. Case is eligible for execution.'
        });
      } catch (err) {
        next(err);
      }
    },

    reject: async (req, res, next) => {
      try {
        const caseId = Number(req.params.id);
        const { reviewer, reason } = req.body || {};

        if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
          return res.status(400).json({
            error: 'MISSING_REVIEWER',
            message: 'Reviewer identity is required for escalation rejection.'
          });
        }

        if (!reason || typeof reason !== 'string' || !reason.trim()) {
          return res.status(400).json({
            error: 'MISSING_REJECTION_REASON',
            message: 'Rejection reason is required.'
          });
        }

        const detail = await repository.getCaseDetail(caseId);
        if (!detail) {
          return res.status(404).json({
            error: 'CASE_NOT_FOUND',
            message: `Recovery case ${caseId} not found.`
          });
        }

        const recoveryCase = detail.recoveryCase;

        if (recoveryCase.escalationStatus === 'REJECTED') {
          return res.status(200).json({
            success: true,
            alreadyRejected: true,
            message: 'Case is already rejected.',
            case: recoveryCase,
            escalation: {
              status: 'REJECTED',
              rejectedBy: recoveryCase.rejectedBy,
              rejectedAt: recoveryCase.rejectedAt,
              reason: recoveryCase.reviewNotes
            }
          });
        }

        if (recoveryCase.escalationStatus === 'APPROVED') {
          return res.status(409).json({
            error: 'CASE_ALREADY_APPROVED',
            message: 'Case was already approved. Cannot reject without unapproving.',
            case: recoveryCase
          });
        }

        const rejectedAt = new Date().toISOString();
        const updatedCase = await repository.updateCase(recoveryCase.id, {
          escalationStatus: 'REJECTED',
          rejectedBy: reviewer.trim(),
          rejectedAt,
          reviewNotes: reason.trim(),
          autonomyStatus: 'BLOCKED',
          lastAutonomyError: `Escalation rejected by ${reviewer.trim()}: ${reason.trim()}`,
          lastEventAt: rejectedAt
        });

        await repository.addAudit(
          recoveryCase.id,
          'ESCALATION_REJECTED',
          `Case recovery rejected by ${reviewer.trim()}: ${reason.trim()}`,
          {
            reviewer: reviewer.trim(),
            reason: reason.trim()
          }
        );

        return res.status(200).json({
          success: true,
          case: updatedCase,
          escalation: {
            status: 'REJECTED',
            rejectedBy: reviewer.trim(),
            rejectedAt,
            reason: reason.trim()
          },
          executionEligible: false,
          message: 'Case recovery rejected by human operations. Automated execution blocked.'
        });
      } catch (err) {
        next(err);
      }
    },

    listPending: async (req, res, next) => {
      try {
        const escalations = await repository.listPendingEscalations();
        return res.status(200).json({ escalations });
      } catch (err) {
        next(err);
      }
    }
  };
}

module.exports = { createEscalationController };
