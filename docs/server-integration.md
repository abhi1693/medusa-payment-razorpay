# Server-side integration

The package exports payment plumbing independently of any store. Never import
these APIs or their configured options into a storefront/client bundle.

```ts
import {
  reconcileRazorpayPayment,
  gatewayReader,
  signedRefundEvent,
  observeRazorpayRefund,
  verifyRazorpayWebhook,
  verifyRazorpayCheckout,
  validateRazorpayCredentials,
} from "@abhi1693/medusa-payment-razorpay"

const options = {
  mode: process.env.RAZORPAY_MODE,
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
  provider_id: "pp_razorpay_razorpay", // match your native registration ID
}
validateRazorpayCredentials(options)
const report = await reconcileRazorpayPayment(
  container,
  nativePaymentId,
  options
)
// Read-only authenticated payment/order/refund checks, exact INR totals,
// bounded pagination/deadline and explicit discrepancy/limitation reporting.
const refund = signedRefundEvent(payload, process.env.RAZORPAY_WEBHOOK_SECRET)
if (refund) {
  await observeRazorpayRefund(container, refund, {
    get: gatewayReader(options),
    reconcile: (id) => reconcileRazorpayPayment(container, id, options),
    coordinate: withFinancialCoordination,
  })
}
```

`coordinate(sessionIds, work)` is an application-supplied async critical section.
Use the same distributed session-and-order financial lock for this observation, `refund_guard`, and your
order-completion gate. The library does not choose a database, create a ledger,
change merchant settings or overwrite environment configuration. The observer
resolves native payment sessions through authenticated gateway order notes,
ignores unassociated payments and throws on discrepancies. It never creates a
refund or automatically imports ambiguous external financial history.

`verifyRazorpayWebhook(rawBytes, signature, secret)` checks the exact HMAC bytes;
`verifyRazorpayCheckout(storedOrderId, paymentId, signature, keySecret)` verifies
Checkout's signature. Ownership, terms acceptance and trusted cart totals remain
the consuming application's responsibility. `signedRefundEvent` supports raw
Buffers and their exact JSON queue serialization, never body reserialization.

Register a subscriber for Medusa's `PaymentWebhookEvents.WebhookReceived` with a
stable subscriber ID, filter your provider registration, and call these APIs.
Enable `refund.created`, `refund.processed`, `refund.failed` and
`refund.speed_changed` subscriptions at
the gateway; payment capture events remain handled by the native payment worker.
Use Medusa's documented Redis Event Module with persistent AOF storage,
`noeviction`, retries and retained failed jobs. A successful HTTP acknowledgement
means durable enqueue, not successful reconciliation. Monitor failures and queue
lag. Native Medusa 2.22.2 already restores serialized webhook Buffer bytes.

Store-specific checkout UI, cart review/ownership, order-completion policy,
invoice behavior, authorization and Redis provisioning stay in the consuming
application. An independent dashboard refund cannot join an application lock or
atomically undo an already completed order; discrepancies require review. These
interfaces support INR in explicitly configured test and live modes; configuration
support does not establish production deployment or bank settlement readiness.

`refund.speed_changed` is an authenticated current-state observation using the
same replay-safe path. Reports include `speed_requested` and `speed_processed`
when returned by the gateway. A speed change never means the refund completed,
never changes native accounting, and never initiates another refund. Existing
webhook subscriptions need no changes when these events are already enabled.
Official semantics: https://razorpay.com/docs/webhooks/refunds/.

An owned captured-payment refund that arrives before native Payment creation
remains retryable, so a browser/webhook association race is not silently ignored.
Uncaptured automatic refunds and genuinely unassociated gateway orders do not
create native payments or refunds. Exhausted association retries require review.

## Refund execution guard

An optional server-side `refund_guard(context, execute)` function can wrap the entire refund verification/request path. The context contains the bound native session ID. It must return `execute()`'s result and propagate errors; a failed guard prevents the gateway request. Every native caller reaches this provider method, including Admin refunds, returns and compensation. Applications can coordinate this boundary with their own order-completion policy without modifying native Medusa routes or models. This extension alone does not create a native/gateway transaction or reconcile uncertain outcomes.

Refund verification covers the native Medusa 2.22.2 runtime and the provider's
2.22.4 build dependency. Refunds below INR 1.00 are rejected before gateway access,
matching the [normal refund API](https://razorpay.com/docs/api/refunds/create-normal/).
The [idempotent normal refund API](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/)
requires replaying the same body and operation key; uncertain outcomes are never
automatically retried by this provider. Native isolated tests include concurrent
cumulative refund caps and refunding the exact remaining balance. They simulate
the gateway and do not prove real gateway settlement.

## Processed refund imports

Use `importRazorpayRefund(container, event, options)` from a trusted backend subscriber after `signedRefundEvent` verifies the raw signed payload. Supply the same explicit account/mode options as reconciliation plus `coordinate(sessionIds, work)` using the same cross-worker financial lock as your refund guard and completion gate.

The importer fetches the refund, payment and order independently; checks native capture, payment/session/order binding, exact INR amounts and cumulative gateway totals; and waits for `processed` state. An external `pending` or `failed` refund changes no financial records. Speed events fetch current state and do not independently advance settlement.

For processed external refunds and verified deferred native requests, it uses the canonical native key `razorpay-observed:<gateway-refund-id>`. This reserved provider path only GETs and verifies an existing processed refund; it never POSTs a refund. The native refund stores immutable import intent in metadata. Native order transactions and credit-line OrderChange/action records have unique refund references and are resumed on replay. No custom model or ledger is introduced. New native refund requests carry an opaque operation hash in gateway notes, keeping a racing native refund distinct from Dashboard activity.

The importer accepts balanced accounting or a native negative pending difference representing an existing owed credit. It pays that credit first and creates a new credit only for the excess, matching native refund-credit semantics. A canceled order is supported only when the refund fits entirely within existing owed credit; it cannot receive a new credit. Positive unpaid differences, active conflicting order changes, unknown individual refund associations and failed native settlement are retained for review rather than repaired by guessing. It does not migrate demo history or use amount-only matching. Never change an uncertain native refund's operation identity or body when upgrading code.

A committed native refund, transaction, pending credit change, credit action and confirmed credit retain stable identities for controlled recovery. Automatic takeover/resume of known incomplete canonical accounting is disabled. `importRazorpayRefund` raises `OperatorRefundRecoveryRequiredError`; the compatibility `reconcileRazorpayRefund` wrapper returns `operator_review_required` without scheduling delayed takeover. Consume legacy queued recovery events through that wrapper and alert an operator. Use the packaged assessment/apply command documented in [operations](operations.md) for supported cases after genuine maintenance quiescence. A completed import replay remains idempotent; a failed/interrupted stage is not permission to start another gateway refund.

After accounting commits, the importer emits Medusa's `payment.refunded` event
with the native payment `id`, native `refund_id` and `gateway_refund_id`. Its native
OrderChange metadata checkpoints successful enqueue. Ordinary duplicate webhook
notifications do not emit it again. A crash between enqueue and its checkpoint
may redeliver the notification; consumers must use the stable refund identity to
deduplicate side effects. This never sends funds again.

Mutable payment/session relations explicitly refresh through public FindConfig
options. Order accounting reads use Medusa Query's current-version projection,
including totals and summary, rather than refreshing a populated versioned Order
entity and accidentally counting historical item details. Native 2.22.2 fixtures
cover multi-version fulfillment/delivery before import and seven notifications
across commit-boundary recovery and full-balance replay.

The consuming native fixture kills a separate Medusa worker with SIGKILL after its pending reservation commits. It verifies the immediate conflict, advances only its test clock past the unchanged grace period, and resumes the same native refund row with balanced accounting and zero gateway refund POSTs.

For payouts that need no new credit, the native order metadata namespace `razorpay_refund_notifications` checkpoints notification enqueue only. It never determines financial amounts or associations, and no zero-value financial change is manufactured. All financial intent remains on the native refund and all cash movement on native refund transactions. The native fixture verifies existing-credit and canceled-owed payouts plus rejected unpaid, canceled-new-credit and ambiguous-refund cases.

## Deferred native refund processing

The provider returns successful refund data only for `processed`. Pending responses raise `GatewayRefundPendingError`, leaving native successful totals and order credits unchanged. Do not treat the native failed/soft-deleted execution attempt as proof of gateway failure: it preserves the operation identity for reconciliation. A normal retry of a known processed gateway request raises `GatewayRefundReconciliationError` so it cannot restore a second native successful attempt.

Use the same signed `reconcileRazorpayRefund` subscriber for Dashboard and deferred native requests. Native-origin gateway notes contain an opaque operation hash and the native session ID. The importer independently matches exactly one original audit attempt, verifies amount and association, and imports only processed funds under `razorpay-observed:<refund-id>`. A failed gateway result changes no successful accounting. Canonical metadata links the original audit attempt and preserves its actor, reason and note when available. Recovery after an interrupted acknowledgement reuses the canonical native row and its frozen credit intent.

Original native reservations that are still pending require operator review; they are never forcibly converted into failures or silently adopted as external requests. The public Medusa API provides no fencing transition for an original worker that may resume. Known incomplete canonical stages require the controlled operator path; background jobs do not take them over. A missing original idempotency key is never repaired by substituting the refund row ID.

## Account-mode boundaries

Use the same explicit `mode`, key ID and API secret for the payment provider, `gatewayReader`, reconciliation, import and delayed recovery subscribers. `RazorpayGateway` now also requires `mode` in its constructor; update direct client callers when adopting 0.0.1. A mode/key mismatch fails locally before any request. The API host remains `https://api.razorpay.com/v1/` in both modes; credentials select the account environment. No automatic credential fallback is performed.

Verify payment and refund webhook bytes with the secret belonging to that endpoint and environment. Invalid signatures fail before gateway reads; valid signatures still require authenticated current-state reads and native order/session binding. The webhook payload is not trusted to select an account or switch modes. An inaccessible or mismatched entity throws rather than changing accounting. `signedRefundEvent` validates the supplied endpoint secret; it does not discover the mode or provision a subscriber.

Live provider registration requires a webhook secret, but that does not prove the endpoint is configured, durable or subscribed correctly. Preserve the documented event/lock/recovery wiring in each environment. Never replay test events or delayed jobs into a live worker, and do not reuse test native session/payment records after changing credentials. Official references: [test/live isolation](https://razorpay.com/docs/payments/dashboard/test-live-modes), [API keys](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys), [webhook setup](https://razorpay.com/docs/payments/dashboard/account-settings/webhooks).

Financial coordination must serialize every payment session belonging to the same order, including refund imports, native refund workflows, order credit changes and completion. A session-only lock does not protect shared order accounting. Resolve and lock the associated order as well; acquire multiple locks in a consistent order and keep ownership through the full callback.

### Order-wide coordination helper

`createRazorpayCoordinator({ resolve, execute })` creates the existing `coordinate(sessionIds, work)` callback. `resolve` must use trusted server-side Medusa associations and return exactly one `{ session_id, order_id }` per session; `order_id: null` explicitly denotes an unattached checkout session. `execute` must hold all supplied keys using a shared distributed locking provider for the full callback and release them on failure. Adapt Medusa's configured Locking Module `execute` method rather than using a process-local mutex.

The helper deduplicates and orders session/order keys and rechecks associations after acquiring them. All participants, including native refund workflows, refund imports, order accounting edits and completion, must use the same key namespace and resolver. Association-changing operations must participate too. This helper is opt-in: it does not silently replace an application's existing coordinator, provide fencing for an expired/lost lock, or change Uniek's adapter.

Canonical refund acknowledgement is implemented separately from refund submission. It receives a frozen GET-only capability and requires an exact processed refund, payment, amount, currency and operation/session association. Missing, changed, failed or pending refunds cannot fall back to POST. This refactor does not enable original pending-reservation takeover: that branch requires operator review, and safe original-worker resumption remains an explicit recovery limitation.
