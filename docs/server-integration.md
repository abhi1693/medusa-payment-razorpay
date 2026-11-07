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
} from "@abhi1693/medusa-payment-razorpay"

const options = {
  mode: "test" as const,
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
  provider_id: "pp_razorpay_razorpay", // match your native registration ID
}
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
Use the same session-keyed lock for this observation, `refund_guard`, and your
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
interfaces are test-mode/INR only and do not assert production deployment or bank
settlement readiness.

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

## Processed Dashboard refund imports

Use `importRazorpayRefund(container, event, options)` from a trusted backend subscriber after `signedRefundEvent` verifies the raw signed payload. Supply the same explicit test-account options as reconciliation plus `coordinate(sessionIds, work)` using the same cross-worker financial lock as your refund guard and completion gate.

The importer fetches the refund, payment and order independently; checks native capture, payment/session/order binding, exact INR amounts and cumulative gateway totals; and waits for `processed` state. An external `pending` or `failed` refund changes no financial records. Speed events fetch current state and do not independently advance settlement.

For processed external refunds, it uses the canonical native key `razorpay-observed:<gateway-refund-id>`. This reserved provider path only GETs and verifies an existing processed external refund; it never POSTs a refund. The native refund stores immutable import intent in metadata. Native order transactions and credit-line OrderChange/action records have unique refund references and are resumed on replay. No custom model or ledger is introduced. New native refund requests carry an opaque operation hash in gateway notes, keeping a racing native refund distinct from Dashboard activity.

The initial importer requires balanced native order accounting. An active order edit/return, unknown individual refund association, canceled order, failed native settlement or a pending native reservation is retained for review rather than repaired by guessing. It does not migrate demo history or use amount-only matching. Never change an uncertain native refund's operation identity or body when upgrading code.

A committed native refund, transaction, pending credit change, credit action and confirmed credit are recovered through their native identities. A hard crash inside Medusa's own pending refund reservation can still require review: there is no supported public takeover/fencing transition for an in-flight native refund. The importer does not delete that reservation or claim exactly-once cross-system execution.

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
