# Operations and validation

## Refund acceptance and processing

Full and partial INR refunds use the native Medusa amount and operation identity. Before a new request, the provider reads bounded gateway refund history, verifies associations and remaining funds, and refuses another debit while a refund is pending. It does not blindly repeat a refund POST.

Only a verified `processed` response can complete successful native refund accounting. A `pending` response raises `GatewayRefundPendingError` (a Medusa conflict) with the gateway refund ID and an instruction not to issue another refund. Native Medusa retains its execution attempt as failed/soft-deleted, so it contributes no successful refund total or order credit. That native execution status is distinct from the gateway's processing state.

The signed reconciliation subscriber must be wired for asynchronous outcomes. On `processed`, the importer verifies the original native operation hash, session, amount and failed audit identity, then creates or resumes one canonical native refund using a GET-only acknowledgement. It retains the original actor/reason/note where available and links the original attempt in metadata. On `failed`, it creates no successful refund, order transaction or credit. Speed changes never independently advance accounting.

If a normal retry finds an already processed gateway operation, it raises `GatewayRefundReconciliationError` instead of restoring the original attempt alongside the canonical import. This prevents two native successful records for one gateway refund. Let the signed subscriber or an authorized invocation of the same coordinator finish reconciliation; do not change the operation identity.

`last_refund_initial_status` is an immutable snapshot of a processed response, not evidence of the customer's bank receipt. Razorpay documents `processed` as its final refund state; bank receipt can take longer. Contract: https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/.

## Uncertain outcomes

A timeout during order creation can leave an unpaid Razorpay order without a native session association. Do not blindly retry the POST. Inspect the gateway order and receipt, then recover or expire the session through an operator workflow.

Preserve a refund's original request identity and body. The importer checks native failed audit attempts and authenticated gateway state, including requests whose original response was lost. Failed canonical acknowledgement attempts retain their original frozen credit intent and resume the same native row. They do not recompute that intent after later order changes.

A stale canonical import reservation uses native same-key takeover after its fifteen-minute grace period, with bounded durable delayed retries. An original native reservation that is still in flight is deferred, not adopted as external funds. If its worker never reaches a terminal native state, exhausted recovery requires review. The provider does not mutate another worker's pending status or delete audit rows. Existing already-succeeded native refunds that later disagree with the gateway also remain explicit discrepancies; there is no destructive migration or invented reversal.

## Delivery and monitoring

Provision durable native Medusa event, workflow and locking providers in the consuming application. Use persistent Redis storage, retries, retained failed jobs and protected logs. An HTTP 200 from the native webhook route acknowledges enqueue; it does not establish successful processing or durable storage unless the application's event infrastructure provides it. Monitor queue age, exhausted retries, worker progress, storage health and financial discrepancies. The package does not provision these services.

Pending gateway refunds remain outside successful native accounting. Gateway failures are observed without manufacturing successful refunds; ambiguous or already-recorded conflicting history requires review. Independent Dashboard actions cannot participate atomically in the application's order-completion lock.

## Validation scope

The Docker tests use a simulated gateway. They establish local verification and lifecycle contracts, not real settlement or production readiness.

The native fixture in `tests/native` runs in a consuming Medusa application's CI image against disposable PostgreSQL. Its `run.mjs` refuses development database targets and drops its temporary database in a finally block. Mount the built package at `/server/owned-razorpay` and register `/server/owned-razorpay/dist` with fixture-only test options in the isolated consumer config. Gateway calls are intercepted. The fixture covers persisted authorization/capture/refund behavior, including a lost refund response and keyed retry.

Account credentials, automatic capture, region activation and a reachable signed webhook endpoint require separate integration validation. Application-owned checkout, authorization and completion rules also need integration coverage. Both modes are exercised with synthetic credentials and simulated HTTP, including signature rejection, account-scoped reads, automatic-capture verification and refunds. No real live transaction or bank settlement is covered by this repository's tests. A consuming deployment still needs separate operational review and account-specific verification.

## Account modes

`mode` is required and must be exactly `test` or `live`. The API key ID prefix must match, and the secret must be nonempty. The same validation is used by the provider, common HTTP client and read-only reconciliation adapter, so refund imports and delayed recovery cannot silently use a different key mode. A nonempty webhook secret is mandatory for live provider initialization. These local checks cannot establish that a credential pair is genuine or that webhook delivery is configured.

Razorpay separates test and live entities through separate API credentials. Isolate the consuming application's databases, queues and webhook endpoints/secrets as well. Switching a running test installation to live credentials does not migrate its orders or refund history and is not a supported migration procedure. Preserve account/mode alignment when processing delayed jobs; never auto-fallback to another account after an authentication or lookup error.

The payment and refund HMAC checks use the configured endpoint secret and exact raw bytes. The provider never selects credentials from an event's claimed account or amount. An accepted signature still leads to authenticated gateway checks before native session/payment association or accounting. Repeated and out-of-order refund events retain the existing idempotent import and recovery behavior in both modes.

Keep automatic capture configured in the selected account. The provider never enables account settings or sends a second capture request. Full and partial refunds still need sufficient available gateway funding; HTTP 400 alone does not prove a funding problem. The minimum normal refund is INR 1.00, and the existing stable-key/uncertain-outcome rules are unchanged.

Avoid raw debug logs with real customers: the requested debugging logger does not redact response bodies. Authentication headers are not intentionally logged, but arbitrary gateway payloads can contain sensitive data. Use `info`, `warning`, `error`, `critical` or `none` with restricted log access/retention.
