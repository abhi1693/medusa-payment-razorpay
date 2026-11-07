# Operations and validation

## Refund acceptance and settlement

Full and partial INR refunds use the native Medusa refund amount and operation identity. The provider validates the gateway refund ID, payment association, exact paise amount, currency and acceptance status. Failed or unknown refund states are rejected. A `pending` response records an accepted refund request, not completed bank settlement; the initial gateway response status is exposed as `last_refund_initial_status` in native payment data. This immutable response snapshot is informational, not a refund ledger or a current settlement status. Later gateway processing does not change it. Retrieve the referenced gateway refund for its current processing state.

If a response is lost or inconsistent, reconcile the gateway operation before issuing another refund. Preserve the original native idempotency identity for a retry; a new operation identity represents a new monetary request. Out-of-band refunds and later refund failures are not automatically synchronized by the current payment webhook handler.

Contract: https://github.com/razorpay/razorpay-node/blob/master/lib/types/refunds.d.ts (reviewed 2026-11-06).

## Uncertain outcomes

A timeout during order creation can leave an unpaid Razorpay order without a native session association. Do not blindly retry the POST. Inspect the gateway order and receipt, then recover or expire the session through an operator workflow. Order initiation does not provide crash-proof exactly-once semantics.

For refunds, retry only the same native operation with its original idempotency identity and body after reconciling the gateway outcome. A new identity is a new monetary request. Dashboard refunds and later failures do not automatically update native financial records. Do not delete a native refund to represent a gateway failure: that alone does not reverse Medusa order or payment-collection accounting.

## Delivery and monitoring

Provision durable native Medusa event, workflow and locking providers in the consuming application. Use persistent Redis storage, retries, retained failed jobs and protected logs. An HTTP 200 from the native webhook route acknowledges enqueue; it does not establish successful processing or durable storage unless the application's event infrastructure provides it. Monitor queue age, exhausted retries, worker progress, storage health and financial discrepancies. The package does not provision these services.

Pending gateway refunds are accepted requests, not proof of settlement. A failed refund needs operator reconciliation and an explicit accounting/retry decision. Independent Dashboard actions cannot participate atomically in the application's order-completion lock.

## Validation scope

The Docker tests use a simulated gateway. They establish local verification and lifecycle contracts, not real settlement or production readiness.

The native fixture in `tests/native` runs in a consuming Medusa application's CI image against disposable PostgreSQL. Its `run.mjs` refuses development database targets and drops its temporary database in a finally block. Mount the built package at `/server/owned-razorpay` and register `/server/owned-razorpay/dist` with fixture-only test options in the isolated consumer config. Gateway calls are intercepted. The fixture covers persisted authorization/capture/refund behavior, including a lost refund response and keyed retry.

Account credentials, automatic capture, region activation and a reachable signed webhook endpoint require separate integration validation. Application-owned checkout, authorization and completion rules also need integration coverage. Live mode is rejected by this release; enabling production payments requires further implementation and release review.
