import { afterEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
import {
  RazorpayProvider as Provider,
  type Options,
  RazorpayGateway,
  gatewayReader,
  signedRefundEvent,
  validateRazorpayCredentials,
  type RazorpayMode,
} from "../src"

const credentials = (mode: RazorpayMode) => ({
  mode,
  key_id: `rzp_${mode}_fixture`,
  key_secret: `${mode}_fixture_secret`,
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("explicit account configuration", () => {
  it.each(["test", "live"] as const)(
    "accepts matching %s credentials without network access",
    (mode) => {
      const fetcher = vi.fn<typeof fetch>()
      vi.stubGlobal("fetch", fetcher)
      expect(() => validateRazorpayCredentials(credentials(mode))).not.toThrow()
      expect(
        () =>
          new Provider(
            {},
            {
              ...credentials(mode),
              webhook_secret: `${mode}_webhook`,
              log_level: "none",
            }
          )
      ).not.toThrow()
      expect(
        () => new RazorpayGateway({ ...credentials(mode), fetch: fetcher })
      ).not.toThrow()
      expect(() => gatewayReader(credentials(mode))).not.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each([
    { mode: undefined },
    { mode: undefined, key_id: "rzp_live_fixture" },
    { mode: "" },
    { mode: "unknown" },
    { mode: "LIVE" },
    { mode: "live", key_id: "rzp_test_fixture" },
    { mode: "test", key_id: "rzp_live_fixture" },
    { key_id: "rzp_test_" },
    { key_id: " rzp_test_fixture" },
    { key_id: "rzp_test_fixture\n" },
    { key_id: "rzp_test_invalid/value" },
    { key_secret: undefined },
    { key_secret: "" },
    { key_secret: "   " },
  ])(
    "rejects malformed/mismatched configuration before any request: %j",
    (override) => {
      const options = { ...credentials("test"), ...override }
      const fetcher = vi.fn<typeof fetch>()
      vi.stubGlobal("fetch", fetcher)
      for (const initialize of [
        () => validateRazorpayCredentials(options),
        () => new Provider({}, options as Options),
        () =>
          new RazorpayGateway({
            ...options,
            fetch: fetcher,
          } as ConstructorParameters<typeof RazorpayGateway>[0]),
        () => gatewayReader(options as Parameters<typeof gatewayReader>[0]),
      ])
        expect(initialize).toThrow("Razorpay")
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each([undefined, "", "   "])(
    "requires a nonempty webhook secret before live initialization: %j",
    (webhook_secret) => {
      expect(
        () => new Provider({}, { ...credentials("live"), webhook_secret })
      ).toThrow(/webhook secret/)
    }
  )
  it("does not include supplied credential values in configuration errors", () => {
    expect(() =>
      validateRazorpayCredentials({
        mode: "live",
        key_id: "rzp_test_privateIdentifier",
        key_secret: "privateSecret",
      })
    ).toThrow("must match")
    try {
      validateRazorpayCredentials({
        mode: "live",
        key_id: "rzp_test_privateIdentifier",
        key_secret: "privateSecret",
      })
    } catch (error) {
      expect(String(error)).not.toMatch(/privateIdentifier|privateSecret/)
    }
  })
})

class FixtureProvider extends Provider {
  constructor(options: Options, transport: typeof fetch) {
    super({}, options)
    this.api = new RazorpayGateway({ ...options, fetch: transport })
  }
}

describe.each(["test", "live"] as const)(
  "%s account lifecycle with simulated HTTP",
  (mode) => {
    it("uses the configured account for checkout, signatures, capture verification and an idempotent refund", async () => {
      const options: Options = {
        ...credentials(mode),
        webhook_secret: `${mode}_webhook`,
        log_level: "none",
      }
      const order = {
        id: "order_fixture",
        amount: 12345,
        currency: "INR",
        status: "paid",
        notes: { medusa_payment_session_id: "payses_fixture" },
      }
      const payment = {
        id: "pay_fixture",
        order_id: order.id,
        amount: 12345,
        currency: "INR",
        status: "captured",
      }
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Basic " +
            Buffer.from(options.key_id + ":" + options.key_secret).toString(
              "base64"
            )
        )
        const path = String(input).replace("https://api.razorpay.com/v1/", "")
        if (path === "orders" && init?.method === "POST")
          return Response.json(order)
        if (path === "orders/" + order.id) return Response.json(order)
        if (path === "orders/" + order.id + "/payments")
          return Response.json({ items: [payment] })
        if (path === "payments/" + payment.id) return Response.json(payment)
        if (path.includes("/refunds?")) return Response.json({ items: [] })
        if (
          path === "payments/" + payment.id + "/refund" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as {
            amount: number
            speed: string
            notes: Record<string, string>
          }
          expect(body.amount).toBe(100)
          expect(body.speed).toBe("normal")
          expect(new Headers(init.headers).get("X-Refund-Idempotency")).toMatch(
            /^[a-f0-9]{64}$/
          )
          return Response.json({
            id: "rfnd_fixture",
            payment_id: payment.id,
            currency: "INR",
            status: "processed",
            ...body,
          })
        }
        throw new Error("Unexpected fixture request")
      })
      const provider = new FixtureProvider(options, transport)
      const initiated = await provider.initiatePayment({
        amount: 123.45,
        currency_code: "inr",
        context: { idempotency_key: "payses_fixture" },
      })
      expect(initiated.data).toMatchObject({
        key_id: options.key_id,
        currency: "INR",
        amount: 12345,
      })
      expect(JSON.stringify(initiated)).not.toContain(options.key_secret)
      const signature = createHmac("sha256", options.key_secret)
        .update(order.id + "|" + payment.id)
        .digest("hex")
      const data = {
        ...initiated.data,
        client: {
          razorpay_order_id: order.id,
          razorpay_payment_id: payment.id,
          razorpay_signature: signature,
        },
      }
      expect((await provider.authorizePayment({ data })).status).toBe(
        "captured"
      )
      await provider.capturePayment({ data })
      const raw = Buffer.from(
        JSON.stringify({
          event: "payment.captured",
          payload: { payment: { entity: { id: payment.id } } },
        })
      )
      const webhook = {
        rawData: raw,
        data: {},
        headers: {
          "x-razorpay-signature": createHmac("sha256", options.webhook_secret!)
            .update(raw)
            .digest("hex"),
        },
      }
      expect((await provider.getWebhookActionAndData(webhook)).action).toBe(
        "captured"
      )
      const beforeInvalid = transport.mock.calls.length
      await expect(
        provider.getWebhookActionAndData({
          ...webhook,
          headers: {
            "x-razorpay-signature": createHmac(
              "sha256",
              "other_environment_webhook"
            )
              .update(raw)
              .digest("hex"),
          },
        })
      ).rejects.toThrow(/signature/)
      expect(transport).toHaveBeenCalledTimes(beforeInvalid)
      const refunded = await provider.refundPayment({
        data,
        amount: 1,
        context: { idempotency_key: "fixture_refund" },
      })
      expect(refunded.data?.last_refund_id).toBe("rfnd_fixture")
      const writes = transport.mock.calls.filter(
        ([, init]) => init?.method === "POST"
      )
      expect(writes).toHaveLength(2) // One order and one refund; no extra capture.
      const refundRaw = Buffer.from(
        JSON.stringify({
          event: "refund.processed",
          payload: {
            refund: { entity: { id: "rfnd_fixture", payment_id: payment.id } },
          },
        })
      )
      const refundPayload = {
        rawData: refundRaw,
        headers: {
          "x-razorpay-signature": createHmac("sha256", options.webhook_secret!)
            .update(refundRaw)
            .digest("hex"),
        },
      }
      expect(signedRefundEvent(refundPayload, options.webhook_secret)).toEqual({
        refund_id: "rfnd_fixture",
        payment_id: payment.id,
      })
      expect(() =>
        signedRefundEvent(refundPayload, "other_environment_webhook")
      ).toThrow(/signature/)
    })
    it("rejects unsupported currencies before a gateway request", async () => {
      const transport = vi.fn<typeof fetch>()
      const provider = new FixtureProvider(
        {
          ...credentials(mode),
          webhook_secret: `${mode}_webhook`,
          log_level: "none",
        },
        transport
      )
      await expect(
        provider.initiatePayment({
          amount: 1,
          currency_code: "usd",
          context: { idempotency_key: "payses_fixture" },
        })
      ).rejects.toThrow("Unsupported currency")
      expect(transport).not.toHaveBeenCalled()
    })
    it("does not accept signed events for inaccessible account entities", async () => {
      const options: Options = {
        ...credentials(mode),
        webhook_secret: `${mode}_webhook`,
        log_level: "none",
      }
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { code: "BAD_REQUEST_ERROR" } },
            { status: 400 }
          )
        )
      const provider = new FixtureProvider(options, transport)
      const raw = Buffer.from(
        JSON.stringify({
          event: "payment.captured",
          payload: { payment: { entity: { id: "pay_otherAccount" } } },
        })
      )
      await expect(
        provider.getWebhookActionAndData({
          rawData: raw,
          data: {},
          headers: {
            "x-razorpay-signature": createHmac(
              "sha256",
              options.webhook_secret!
            )
              .update(raw)
              .digest("hex"),
          },
        })
      ).rejects.toThrow(/reconcile/)
      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport.mock.calls[0][1]?.method).toBe("GET")
    })
  }
)
