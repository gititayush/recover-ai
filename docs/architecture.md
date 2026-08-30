# RecoverAI architecture — milestone 1

```text
Normalized payment event
        |
        v
POST /api/events (validation + event-id idempotency)
        |
        v
PostgreSQL revenue_events (raw payload retained)
        |
        v
Deterministic risk detector
        |
        v
RecoveryCase + append-only audit events
        |
        v
REST case API -> React operations dashboard
```

## Current flow

The backend accepts normalized test payment events. `eventId` is unique, so retrying the same event is safe. A `payment.failed` event creates a `RECOVERABLE` case. Repeated failures elevate its risk level. `payment.captured`, `payment.succeeded`, and `order.paid` resolve an existing case; `payment.refunded` suppresses one. Every case state transition creates a queryable audit event.

The React dashboard reads the actual case APIs and calculates its totals from returned cases. The Node simulator submits fixed scenarios; it does not generate random or dashboard-only data.

## Deferred layers

No LLM is connected in this milestone. Future AI will return a validated, structured diagnosis/recommendation only. It will not execute an action.

The deterministic financial-action policy layer, Razorpay Test Mode webhook/signature integration, and bounded action executors are also deferred. They will sit after AI diagnosis and before any provider request.
