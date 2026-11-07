# Medusa Razorpay

[![Medusa 2.22.2 / 2.22.4](https://img.shields.io/badge/Medusa-2.22.2%20%7C%202.22.4-7c3aed)](https://docs.medusajs.com/)
[![Test mode](https://img.shields.io/badge/Razorpay-test%20mode-2563eb)](#supported-payment-lifecycle)
[![MIT license](https://img.shields.io/github/license/abhi1693/medusa-payment-razorpay)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-abhi1693-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/abhi1693)

A Razorpay payment provider for Medusa v2, with verified checkout results, automatic-capture payments, full and partial refunds, and reusable server-side reconciliation helpers. Uses native Medusa payment sessions, payments, captures and refunds without additional models or a financial ledger.

**Currently supports INR in Razorpay test mode only. Live credentials and unsupported currencies are rejected.** Automatic capture must already be configured in your Razorpay test account.

[Setup](#installation-and-configuration) · [Checkout](#storefront-checkout) · [Webhooks](#webhooks) · [Server integration](docs/server-integration.md) · [Operations](docs/operations.md)

## Supported payment lifecycle

| Capability            | Behavior                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment sessions      | Creates a Razorpay order from the server-provided Medusa amount, with precise rupee-to-paise conversion and a native session association.                                                                                                                                          |
| Checkout verification | Verifies the signature, fetched payment and order, amount, INR currency and session association before accepting payment.                                                                                                                                                          |
| Automatic capture     | Requires captured gateway funds before authorization completes. Native capture verifies gateway state and never sends another capture request.                                                                                                                                     |
| Failed attempts       | Allows another attempt on the same order after the previous bound attempt has failed. Successful or in-progress associations cannot silently be replaced.                                                                                                                          |
| Cancellation          | Cancels/deletes an unpaid session locally; rejects cancellation when gateway payment is authorized or captured. It does not cancel a Razorpay order or issue an implicit refund.                                                                                                   |
| Refunds               | Full and partial normal-speed refunds, minimum INR 1.00, with a stable native operation key sent through Razorpay's idempotent refund API.                                                                                                                                         |
| Payment webhooks      | Signed `payment.authorized` and `payment.captured` events re-fetch gateway state; native processing proceeds only after capture.                                                                                                                                                   |
| Refund observation    | Signed refund events trigger authenticated current-state checks through optional application wiring. The optional importer records verified processed Dashboard and deferred native refunds in native accounting without sending funds again. Pending/failed refunds do not create accounting entries. |

The declared framework peer versions are **2.22.2 and 2.22.4**. Native application validation targets Medusa 2.22.2; package development uses 2.22.4. This repository provides a payment module provider and server helpers. Checkout UI, customer authorization, terms acceptance, order-completion policy and infrastructure belong to the consuming application.

## Installation and configuration

The package is currently private in `package.json` and is not an npm release. Install from Git using a reviewed full commit SHA and commit your application's lockfile:

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

These are placeholders. Never commit actual credentials or expose the secret or webhook secret to a frontend. The key ID is public checkout configuration. The only supported mode is `test`; startup rejects missing/invalid test API credentials. The webhook secret may be omitted for initial Admin setup, but webhooks fail closed until a valid secret is configured.

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

Subscribe to `payment.authorized` and `payment.captured` in the matching Razorpay test account. Preserve the exact raw request bytes and `x-razorpay-signature` header. The provider verifies HMAC signatures and fetches current gateway state, making repeated and out-of-order notifications safe to re-evaluate. `payment.failed` and other unsupported payment events are ignored; they do not invalidate a later checkout attempt.

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
