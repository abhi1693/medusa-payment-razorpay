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

Known incomplete canonical reservations or accounting now require controlled operator recovery. Background reconciliation returns `operator_review_required` without scheduling another takeover. Existing delayed recovery-event identifiers remain exported so applications can consume old queued jobs safely; no new recovery jobs are scheduled. Original native pending reservations are never retried or converted. Native successes with uncertain accounting remain explicit review cases.

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

## Controlled operator recovery

Use `assessRazorpayRefundRecovery(container, target, options)` for a read-only assessment. The target contains a **native** `native_payment_id` and a **gateway** `gateway_refund_id`; they are not interchangeable. Options use the existing trusted server credentials and an order-wide distributed `coordinate` callback. The assessment returns `ready`, `complete` or `quarantined`, a reason, and a review fingerprint where applicable. Approval is bound to the configured mode, key identity, provider and financial snapshot; changing accounts or modes requires a new assessment. Inspection errors fail closed. Assessments do not issue refunds or change accounting.

Execution is a privileged server-side operation, not a public route or an Admin button. Call `recoverRazorpayRefund(container, target, options, { fingerprint, control })` only after reviewing that exact assessment. `control` implements the exported `RefundRecoveryControl` contract:

```ts
interface RefundRecoveryControl {
  withQuiescence<T>(
    work: (assertQuiescent: () => Promise<void>) => Promise<T>
  ): Promise<T>
}
```

The application/deployment operator must implement this control to stop and verify termination of every original worker, suspended process and old replica; disable durable workflow/job retries; gate new refund requests, refund subscribers/imports, completion and relevant order edits; and preserve exclusive maintenance ownership until the callback finishes. Account for queued jobs before resuming normal workers. A boolean acknowledgement, a lock timeout, workflow cancellation request or terminated database connection does not establish quiescence. The plugin cannot inspect or stop an arbitrary deployment and does not provide write-side fencing. Never supply a no-op control in an application. Tests use isolated controls because the disposable environment is owned by the fixture.

The tool checks quiescence, re-reads the approved financial snapshot under coordination, and refuses stale fingerprints. It calls the existing importer inside the already-held critical section, then verifies native refund, exact transaction, frozen credit intent, order totals and gateway state. `changes_possible: true` means native commits may have occurred, even when the result is quarantined: inspect again before any retry. A complete result may be replayed without new accounting; a changed or partial state requires a fresh reviewed assessment.

This first operator API deliberately supports a single processed gateway refund on an unambiguous single-payment order, including clean Dashboard imports and resumable canonical import stages. A failed, soft-deleted original attempt is eligible only when its exact operation association is verified and no conflicting accounting exists. Original pending reservations remain quarantined; the tool never retries them, substitutes their row IDs for missing idempotency keys, deletes audit records or changes their statuses. A succeeded original is also quarantined for credit/accounting review: its existence alone is not evidence that the native workflow completed every stage. Multiple refund histories/payment associations, pending/failed gateway outcomes, unrelated pending order changes, missing summaries and ambiguous or inconsistent accounting require review. The tool does not send a refund POST, reverse accounting, silently repair arbitrary credits or fabricate a gateway outcome.

For an original crashed-pending reservation, controlled assessment is available but automatic or manual takeover is not implemented. A separate reviewed recovery mechanism would need conclusive worker termination plus accounting reconciliation; the ordinary refund button or an unkeyed replay is not that mechanism. Preserve the original gateway refund ID, native attempt and stored idempotency key. If gateway access or outcome is unresolved, retain the quarantine and investigate rather than submit another monetary request.

### Packaged operator command

The package includes a Medusa `exec` entry point. Run it from the backend project, using its installed plugin version and trusted server-side configuration:

```sh
npx medusa exec ./node_modules/@abhi1693/medusa-payment-razorpay/dist/scripts/refund-recovery.js assess ./src/scripts/razorpay-recovery-config.ts pay_NATIVE rfnd_GATEWAY
```

The configuration file must default-export a `RefundRecoveryConfigurationFactory`. For an assessment-only setup, this is a complete example; it deliberately has no execution maintenance control:

```ts
import type { RefundRecoveryConfigurationFactory } from "@abhi1693/medusa-payment-razorpay"
import { createRazorpayRecoveryOptions } from "@abhi1693/medusa-payment-razorpay"

const configure: RefundRecoveryConfigurationFactory = (container) => {
  const mode = process.env.RAZORPAY_MODE
  if (mode !== "test" && mode !== "live")
    throw new Error("Configure RAZORPAY_MODE")
  return {
    options: createRazorpayRecoveryOptions(
      container,
      {
        mode,
        key_id: process.env.RAZORPAY_KEY_ID || "",
        key_secret: process.env.RAZORPAY_KEY_SECRET || "",
        provider_id: "pp_razorpay_razorpay",
      },
      "razorpay-financial"
    ),
  }
}
export default configure
```

`razorpay-financial` must be the ID of a configured durable native Locking Module provider, for example `@medusajs/medusa/locking-postgres`. The helper resolves native session/order associations through Medusa, rejects ambiguous associations and explicitly selects that provider. It does not silently choose an in-memory default. Configure your actual provider ID if it differs.

The command writes a JSON result with `type: "razorpay_refund_recovery"`. Review its status, reason, IDs, amount and fingerprint. A `quarantined` result exits unsuccessfully. For execution, the same configuration factory must also return an application-enforced `control: RefundRecoveryControl` implementing the maintenance requirements above. The assessment-only example refuses `apply` until this control is integrated; the package does not infer stopped workers or accept an unchecked command-line confirmation flag.

After the exact assessment has been reviewed and maintenance is verified:

```sh
npx medusa exec ./node_modules/@abhi1693/medusa-payment-razorpay/dist/scripts/refund-recovery.js apply ./src/scripts/razorpay-recovery-config.ts pay_NATIVE rfnd_GATEWAY REVIEWED_64_CHARACTER_SHA256
```

Replace the placeholders with the real native payment ID, gateway refund ID and unchanged assessment fingerprint. Never pass credentials as command arguments. The local configuration module runs with backend operator privileges and must be trusted. This command is not a refund submission command: it only imports supported existing processed funds. Stop on quarantine; a changed/partially committed state needs a fresh assessment, not an automatic retry. Independently verify one native successful refund, one correctly referenced refund transaction, the intended credit (or payout against an existing credit), payment/order totals and no additional gateway refund before releasing maintenance. Surface `operator_review_required` from background reconciliation in your application's monitoring; the plugin does not add an Admin recovery UI.
