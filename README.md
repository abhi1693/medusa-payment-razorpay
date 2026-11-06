# Medusa Razorpay payment provider

Original INR-only automatic-capture provider for Medusa 2.22.2. Test mode only.
Uses native PaymentSession/Payment data and native capture/refund records. No custom models, database or ledger.

## Configuration

Do not register the provider unless explicitly enabled. Keep secrets in your deployment's private environment, never frontend code or version control.

```ts
...(process.env.RAZORPAY_ENABLED === "true" ? [{
  resolve: "@medusajs/medusa/payment",
  options: { providers: [{
    resolve: "@abhi1693/medusa-payment-razorpay", id: "razorpay",
    options: { enabled: true, mode: "test", key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET, webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET }
  }] }
}] : [])
```

Enable `pp_razorpay_razorpay` only in the intended test region after separate operator activation. Automatic capture must already be configured in the test account. This plugin never changes account settings and never sends a capture POST. Authorization completes only after gateway status is captured. It rejects unsupported currencies, invalid precision and live key IDs.

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
