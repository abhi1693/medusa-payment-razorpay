# Medusa Razorpay

[![Medusa 2.22.2 / 2.22.4](https://img.shields.io/badge/Medusa-2.22.2%20%7C%202.22.4-7c3aed)](https://docs.medusajs.com/)
[![MIT license](https://img.shields.io/github/license/abhi1693/medusa-payment-razorpay)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-abhi1693-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/abhi1693)

A Razorpay payment provider for Medusa v2, with verified checkout results, automatic-capture payments, full and partial refunds, and reusable server-side reconciliation helpers. Uses native Medusa payment sessions, payments, captures and refunds without additional models or a financial ledger.

**Supports INR with explicitly configured Razorpay test or live credentials.** Unsupported currencies and mode/key mismatches are rejected. Automatic capture must already be configured in the selected Razorpay account. Live-mode support is a configuration capability, not a claim that real-money processing or a deployment has been validated.

[Setup](#installation-and-configuration) · [Checkout](#storefront-checkout) · [Webhooks](#webhooks) · [Server integration](docs/server-integration.md) · [Operations](docs/operations.md)

## Supported payment lifecycle

| Capability            | Behavior                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payment sessions      | Creates a Razorpay order from the server-provided Medusa amount, with precise rupee-to-paise conversion and a native session association.                                                                                                                                                              |
| Checkout verification | Verifies the signature, fetched payment and order, amount, INR currency and session association before accepting payment.                                                                                                                                                                              |
| Automatic capture     | Requires captured gateway funds before authorization completes. Native capture verifies gateway state and never sends another capture request.                                                                                                                                                         |
| Failed attempts       | Allows another attempt on the same order after the previous bound attempt has failed. Successful or in-progress associations cannot silently be replaced.                                                                                                                                              |
| Cancellation          | Cancels/deletes an unpaid session locally; rejects cancellation when gateway payment is authorized or captured. It does not cancel a Razorpay order or issue an implicit refund.                                                                                                                       |
| Refunds               | Full and partial normal-speed refunds, minimum INR 1.00, with a stable native operation key sent through Razorpay's idempotent refund API.                                                                                                                                                             |
| Payment webhooks      | Signed `payment.authorized` and `payment.captured` events re-fetch gateway state; native processing proceeds only after capture.                                                                                                                                                                       |
| Refund observation    | Signed refund events trigger authenticated current-state checks through optional application wiring. The optional importer records verified processed Dashboard and deferred native refunds in native accounting without sending funds again. Pending/failed refunds do not create accounting entries. |

The declared framework peer versions are **2.22.2 and 2.22.4**. Native application validation targets Medusa 2.22.2; package development uses 2.22.4. This repository provides a payment module provider and server helpers. Checkout UI, customer authorization, terms acceptance, order-completion policy and infrastructure belong to the consuming application.

## Installation and configuration

For source installation, use a reviewed full commit SHA and commit your application's lockfile:

```sh
npm install 'git+https://github.com/abhi1693/medusa-payment-razorpay.git#<reviewed-full-commit-sha>'
```

Git installation runs the package's TypeScript build through its `prepare` script. Your build environment needs Git, Node.js and the declared peer dependency. The repository's Docker toolchain uses Node.js 24.

Add the provider to your existing Payment Module configuration in `medusa-config.ts`:

```ts
{
  resolve: "@medusajs/medusa/payment",
  options: {
    providers: [
      // Keep your other payment providers here.
      {
        resolve: "@abhi1693/medusa-payment-razorpay",
        id: "razorpay",
        options: {
          mode: process.env.RAZORPAY_MODE,
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
          webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET,
        },
      },
    ],
  },
}
```

Configure the backend's private environment:

```dotenv
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_REPLACE_ME
RAZORPAY_KEY_SECRET=REPLACE_ME
RAZORPAY_WEBHOOK_SECRET=REPLACE_ME
```

These are placeholders. Never commit actual credentials or expose the secret or webhook secret to a frontend. The key ID is public checkout configuration. Set `mode` explicitly to `test` or `live`: the key ID must begin with the matching `rzp_test_` or `rzp_live_` prefix and a nonempty API secret is required. Missing/unknown modes, malformed IDs and mismatches fail before network access; the plugin never infers live mode from a key. This validates configuration shape, not whether the key/secret pair is valid at Razorpay.

For live configuration, use `RAZORPAY_MODE=live`, a matching live key ID and that environment's API and webhook secrets. **Live provider initialization requires a nonempty webhook secret.** Test mode may omit it for initial Admin setup, but webhook delivery always fails closed without a valid secret. Use separate deployments/data, credentials and webhook endpoints/secrets for test and live; do not switch an existing test database into live processing. See [account modes](docs/operations.md#account-modes).

Start the backend through your application's normal workflow. In **Admin → Settings → Regions → your region**, select the Razorpay payment provider. This registration produces provider ID **`pp_razorpay_razorpay`**. Registration alone does not associate it with a region. There is no enabled/disabled environment toggle and no custom Admin menu or plugin migration.

## Storefront checkout

1. Create/select a native Medusa payment session using `pp_razorpay_razorpay`.
2. Initialize Razorpay Checkout using the session's public `key_id`, `order_id`, `amount` (paise) and `currency` (`INR`).
3. Submit `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature` through Medusa's Store payment-session client-data endpoint (`data.client`). Keep the stored server session fields authoritative.
4. Complete the cart through your backend's normal ownership, cart-total and acceptance checks. While automatic capture is pending, wait/reconcile rather than treating authorization as a completed payment.

The provider includes no checkout widget and makes no blanket promise about individual Razorpay payment methods. Available methods depend on the merchant account and Checkout configuration. Enforce application rules on the server: native payment webhooks may complete carts without the browser returning.

## Webhooks

For the example registration above, use your **backend's public HTTPS origin** with:

```text
/hooks/payment/razorpay_razorpay
```

Subscribe to `payment.authorized` and `payment.captured` in the matching Razorpay account and mode. Preserve the exact raw request bytes and `x-razorpay-signature` header. The provider verifies HMAC signatures and fetches current gateway state, making repeated and out-of-order notifications safe to re-evaluate. `payment.failed` and other unsupported payment events are ignored; they do not invalidate a later checkout attempt.

For refund observation, also subscribe to `refund.created`, `refund.processed`, `refund.failed` and `refund.speed_changed`, and wire the exported server helpers into an application subscriber. These events require an application subscriber calling the importer; provider registration alone does not import accounting. A speed change updates informational observations only; it never means settlement or initiates a refund.

See [server integration](docs/server-integration.md) for the helper contract, shared locking hook and subscriber requirements. Use durable Medusa event infrastructure and monitor failed jobs; HTTP acknowledgement is not proof of successful reconciliation.

## Refunds and reconciliation

Initiate refunds through Medusa's native refund workflow and preserve the operation identity. A synchronously processed response completes normally. A pending gateway response returns an explanatory conflict and remains outside successful native refund accounting. Wire the signed refund subscriber below: a later processed event imports one successful native refund, while a later failed event creates no successful refund accounting. The original native failed attempt remains as audit evidence; it does not mean the gateway request failed. Do not issue a new operation merely to retry a pending request. `last_refund_initial_status` is an immutable processed-response snapshot, not proof of bank receipt.

The exported reconciliation helpers compare authenticated gateway payment/order/refund information with native records. The read-only report helpers never change records. The optional importer uses native financial APIs only for individually verified processed Dashboard and deferred native refunds and rejects ambiguous associations. Review discrepancies before retrying an uncertain request. Applications can supply a `refund_guard` and a common session-keyed lock to coordinate refund execution, observation and order completion.

Read [operations and validation](docs/operations.md) for pending/failed refund handling, uncertain outcomes, monitoring and test limits.

## Development

Use the repository's Docker Compose tools service:

```sh
docker compose build tools
docker compose run --rm tools npm run typecheck
docker compose run --rm tools npm test
docker compose run --rm tools npm run build
docker compose run --rm tools npm run format:check
```

The image installs the committed lockfile with `npm ci`; the tools container has no network access. Automated gateway tests are simulated and do not create Razorpay payments or refunds. Native lifecycle fixtures require an isolated consuming Medusa CI environment; see [validation scope](docs/operations.md#validation-scope).

## License

[MIT](LICENSE) © Abhimanyu Saharan.

### Logging

Set provider option `log_level` to `debug`, `info` (default), `warning`, `error`, `critical`, or `none`. Thresholds include the selected level and higher severities. `none` emits no plugin log records. JSON records contain `level`, a clear `message`, and `context`. The simple shared logger uses Medusa's injected logger, with a console fallback. Warning uses the `warn` sink; critical uses `error` while retaining its JSON severity.

All API calls use one typed HTTP client with `get`, `post`, `put`, `patch` and `delete`. Authentication, timeout, parsing, and request/response logging live in its single executor. Callers do not add HTTP logging code or classifications. Request context includes the complete supplied API path (including pagination), method, a local correlation UUID and timing. Paths contain opaque gateway resource IDs; these are included as requested.

Debug records receive the complete request body and provider response, including unknown response keys. There is no provider-field extraction or event-schema framework. Authentication headers are never supplied to the logger. Redaction is intentionally not implemented for the current debugging stage. Raw debug bodies can contain personal or sensitive data. Restrict access and retention, and use test data. Keep live deployments at `info` or higher (or `none`); raw `debug` payloads are not suitable for routine live logging. Authentication headers and configured credentials are not intentionally added to log context; an upstream response or caller-supplied body can still contain sensitive values. Other levels omit request/response bodies.

### Common API client

`RazorpayGateway` takes a named `GatewayOptions` object with explicit `mode`, matching credentials, optional Medusa logger, log level, timeout and injectable `fetch` for isolated testing. The base host is fixed, redirects are rejected, authentication cannot be overridden by custom headers, and timeout is bounded at 15 seconds. Reconciliation uses its GET-only adapter with a 30-second aggregate deadline. The compatibility `request` method delegates to the same executor; plugin internals use explicit verbs.

`GatewayRequestError` has typed method, failure kind and optional HTTP status. Transport failures are generic; response errors remain distinct from HTTP errors. No HTTP method retries automatically. `reconciliation_required` is a precaution on failed writes, not proof of a mismatch or a completed reconciliation. GET failures set it false. A successful HTTP response does not establish refund settlement.

### Development checks

Run project commands through Docker Compose:

```sh
docker compose build tools
docker compose run --rm tools npm run format:check
docker compose run --rm tools npm run lint
docker compose run --rm tools npm run typecheck
docker compose run --rm tools npm test
docker compose run --rm tools npm run build
docker compose run --rm tools npm run package:check
```

Prettier checks the repository, including documentation and configuration; `.editorconfig` and `.prettierrc.json` define the shared editor style. Generated files, private environment files and local scratch files are ignored. To apply formatting to the checkout, use the tools container with the repository mounted at `/plugin` and its image dependencies available, or the Compose bootstrap service after installing development dependencies.

Typecheck validates both the published source and unit tests. The test project matches Vitest's ESM resolution; malformed runtime fixture values remain explicit test boundaries. The scripts under `tests/native` are consuming-Medusa integration fixtures and resolve/run inside that application's isolated test environment, not the standalone unit-test project.

The GitHub workflow runs formatting, lint, typecheck and build as separately visible checks, reusing the pinned Node CI and security workflows from `abhi1693/actions`. Each unit suite runs independently in its own matrix job and uploads JUnit XML. Reproduce a selected suite locally with `docker compose run --rm tools npm test -- tests/http-client.test.ts`. These self-contained suites use mocked gateway/service fixtures and do not perform gateway transactions. Hosted results and consuming-application integration evidence remain separate from local unit checks.

### Rejected refund requests

A refund POST rejected with HTTP 400 raises `RazorpayRefundRejectedError`
(`invalid_data`, code `razorpay_refund_rejected`). Medusa Admin can show its
actionable message instead of a generic server error. The message asks operators
to verify the refund status and available balance before retrying. HTTP 400 alone does not establish insufficient balance.
Transport failures and other uncertain responses retain reconciliation handling;
the provider never retries a refund automatically.

## Release status

The `0.0.1` artifact includes compiled JavaScript, TypeScript declarations, the license, README and integration/operations guides. `package:check` builds and packs it locally, checks its contents, loads its public exports and compiles a consumer against its packed declarations. CI runs this as an independent check without publishing. Release notes belong to the GitHub release.

`ci.yaml` is displayed as **CI** and runs on every push and pull request, plus reusable/manual invocations. `publish.yaml` runs only for a published stable GitHub release, reuses CI, verifies the tag/version and master ancestry, builds through Docker, then publishes the packed artifact with npm OIDC. Before release publication, the owner must establish npm package ownership, configure the trusted publisher for `abhi1693/medusa-payment-razorpay`, workflow `publish.yaml`, environment `npm-publish`, and allow direct `npm publish`. Configure environment review protection separately. No registry token is stored by this repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). Publishing and GitHub release creation are separate owner actions.
