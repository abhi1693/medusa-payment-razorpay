# Medusa Razorpay payment provider

Original INR-only automatic-capture provider for Medusa 2.22.2. Test mode only.
Uses native PaymentSession/Payment data and native capture/refund records. No custom models, database or ledger.

## Configuration

Register the provider directly. Keep API credentials in the private backend environment, never frontend code or version control.

```ts
{
  resolve: "@medusajs/medusa/payment",
  options: { providers: [{
    resolve: "@abhi1693/medusa-payment-razorpay", id: "razorpay",
    options: { mode: "test", key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET, webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET }
  }] }
}
```

The native provider ID is `pp_razorpay_razorpay`. Registration makes it available in native region settings; it does not assign it to a region. There is no enable/disable environment toggle. Test API credentials are required at startup. The webhook secret is optional for basic Admin setup; incoming webhooks fail closed until it is configured. Automatic capture must already be configured in the test account. This plugin never changes account settings or sends a capture POST. Authorization completes only after gateway status is captured. Unsupported currencies, invalid precision and live key IDs are rejected.

Checkout results must be submitted using Medusa's Store payment-session client-data endpoint (`data.client`). The provider checks the stored order ID, HMAC, fetched gateway payment/order, amount, currency and session note. Session data is public-safe; do not store secrets there.

Configure test webhooks at `/hooks/payment/razorpay_razorpay`. Raw request bytes are mandatory. Captured events and duplicate/out-of-order authorization notifications re-fetch gateway state and use native payment processing. Invalid signatures throw; unsupported events are ignored. This is replay-safe processing, not an exactly-once event audit. Configure durable native event/workflow/locking providers and retention appropriate to operations.

Native refund context supplies a stable idempotency key. The plugin hashes it with the order ID and sends Razorpay's `X-Refund-Idempotency` header. Retry only through the same keyed native operation. Reconcile unexpected gateway results before starting a new operation. Capture is read-only because automatic capture owns that gateway transition.

A timeout during order creation can leave an unpaid gateway order without a native association. Do not implement a blind HTTP POST retry: inspect gateway orders/receipt and recover or expire the session through an operator workflow. This release does not claim crash-proof exactly-once order initiation.

Applications must enforce their checkout acceptance/ownership rules in backend completion validation because native payment webhooks may complete carts without the browser returning. Do not use provider data as an authorization mechanism.

## Development

All commands run through Docker Compose. Run `docker compose build tools`, then `docker compose run --rm tools npm run typecheck`, `docker compose run --rm tools npm test`, and `docker compose run --rm tools npm run build`. Run formatting through the same tools service. The committed lockfile is used by `npm ci` in the Docker build.

No live gateway operations belong in automated tests. Mocked tests establish local contracts only. Account credentials, automatic-capture configuration, region activation and a reachable test webhook endpoint are required for separately authorized end-to-end validation.

## Validation scope

The native lifecycle fixture in `tests/native` is run in the consuming application CI image against a fresh disposable PostgreSQL database. `run.mjs` refuses development database targets and drops its temporary database in a finally block. Mount the built provider at `/server/owned-razorpay` and register its `/server/owned-razorpay/dist` provider path with fixture-only test options in the isolated consumer config. All gateway calls in this fixture are intercepted; no Razorpay transactions are created. It verifies persisted native authorization/capture/refund behavior, including a lost refund response and keyed retry.

This repository has no checkout UI, merchant acceptance policy, or application-specific routes. Those belong to the consuming application. A production release, account activation and real gateway verification are separate review gates.

Failed gateway attempts can be retried on the same order. A replacement attempt is accepted only after the prior bound attempt is terminally failed; authorized, captured or refunded associations are never silently rebound. Session updates include the public gateway_status so the consuming checkout can distinguish an unpaid/failed order from one awaiting automatic capture.

### Refund acceptance and settlement

Full and partial INR refunds use the native Medusa refund amount and operation identity. The provider validates the gateway refund ID, payment association, exact paise amount, currency and acceptance status. Failed or unknown refund states are rejected. A `pending` response records an accepted refund request, not completed bank settlement; the initial gateway response status is exposed as `last_refund_initial_status` in native payment data. This immutable response snapshot is informational, not a refund ledger or a current settlement status. Later gateway processing does not change it. Retrieve the referenced gateway refund for its current processing state.

If a response is lost or inconsistent, reconcile the gateway operation before issuing another refund. Preserve the original native idempotency identity for a retry; a new operation identity represents a new monetary request. Out-of-band refunds and later refund failures are not automatically synchronized by the current payment webhook handler.

Contract: https://github.com/razorpay/razorpay-node/blob/master/lib/types/refunds.d.ts (reviewed 2026-11-06).

### Application refund coordination

An optional server-side `refund_guard(context, execute)` function can wrap the entire refund verification/request path. The context contains the bound native session ID. It must return `execute()`'s result and propagate errors; a failed guard prevents the gateway request. Every native caller reaches this provider method, including Admin refunds, returns and compensation. Applications can coordinate this boundary with their own order-completion policy without modifying native Medusa routes or models. This extension alone does not create a native/gateway transaction or reconcile uncertain outcomes.

Refund verification covers the native Medusa 2.22.2 runtime and the provider's
2.22.4 build dependency. Refunds below INR 1.00 are rejected before gateway access,
matching the [normal refund API](https://razorpay.com/docs/api/refunds/create-normal/).
The [idempotent normal refund API](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/)
requires replaying the same body and operation key; uncertain outcomes are never
automatically retried by this provider. Native isolated tests include concurrent
cumulative refund caps and refunding the exact remaining balance. They simulate
the gateway and do not prove real gateway settlement.

## Reusable server-side integration APIs

The package exports payment plumbing independently of any store. Never import
these APIs or their configured options into a storefront/client bundle.

```ts
import {
  reconcileRazorpayPayment, gatewayReader,
  signedRefundEvent, observeRazorpayRefund,
  verifyRazorpayWebhook, verifyRazorpayCheckout,
} from "@abhi1693/medusa-payment-razorpay"

const options = {
  mode: "test" as const,
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
  provider_id: "pp_razorpay_razorpay", // match your native registration ID
}
const report = await reconcileRazorpayPayment(container, nativePaymentId, options)
// Read-only authenticated payment/order/refund checks, exact INR totals,
// bounded pagination/deadline and explicit discrepancy/limitation reporting.
const refund = signedRefundEvent(payload, process.env.RAZORPAY_WEBHOOK_SECRET)
if (refund) {
  await observeRazorpayRefund(container, refund, {
    get: gatewayReader(options),
    reconcile: id => reconcileRazorpayPayment(container, id, options),
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
