import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import { BigNumber } from "@medusajs/framework/utils"
import Provider, { type Options } from "../src/service"
import { minor, verify } from "../src/security"
import { RazorpayGateway, type Entity, type Gateway } from "../src/gateway"
const options: Options = {
  enabled: true,
  mode: "test",
  key_id: "rzp_test_fixture",
  key_secret: "fixture_secret",
  webhook_secret: "fixture_webhook",
}
const data = {
  order_id: "order_123",
  session_id: "payses_123",
  amount: 12345,
  currency: "INR",
}
const order = {
  id: "order_123",
  amount: 12345,
  currency: "INR",
  status: "paid",
  notes: { medusa_payment_session_id: "payses_123" },
}
const payment = {
  id: "pay_123",
  order_id: "order_123",
  amount: 12345,
  currency: "INR",
  status: "captured",
}
const sign = (s: string, secret = options.key_secret) =>
  createHmac("sha256", secret).update(s).digest("hex")
class TestProvider extends Provider {
  setGateway(api: Gateway) {
    this.api = api
  }
}
let provider: TestProvider
let request: ReturnType<typeof vi.fn>
beforeEach(() => {
  request = vi.fn(async (path: string) => {
    if (path === "orders/order_123") return order
    if (path === "orders/order_123/payments") return { items: [payment] }
    if (path === "payments/pay_123") return payment
    if (path === "orders") return order
    if (path === "payments/pay_123/refund")
      return {
        id: "rfnd_123",
        amount: 100,
        currency: "INR",
        status: "processed",
      }
    throw new Error("Unexpected request " + path)
  })
  provider = new TestProvider({}, options)
  provider.setGateway({ request: request as Gateway["request"] })
})
describe("INR amount and signatures", () => {
  it.each([
    "123.45",
    123.45,
    new BigNumber("123.45"),
    { value: "123.45", precision: 20 },
  ])("converts native decimal inputs precisely", (v) =>
    expect(minor(v, "inr")).toBe(12345)
  )
  it.each([0, -1, "1.001", "NaN", Infinity, "9007199254740992"])(
    "rejects invalid amount %s",
    (v) => expect(() => minor(v, "INR")).toThrow()
  )
  it("rejects unsupported currencies", () =>
    expect(() => minor(1, "USD")).toThrow())
  it("verifies raw bytes and rejects tampering", () => {
    verify(Buffer.from("abc"), sign("abc"), options.key_secret)
    expect(() => verify("abcd", sign("abc"), options.key_secret)).toThrow()
    expect(() => verify("abc", "bad", options.key_secret)).toThrow()
  })
})
describe("configuration", () => {
  it.each([
    { enabled: false },
    { mode: "live" },
    { key_id: "rzp_live_fixture" },
    { key_secret: "" },
    { webhook_secret: "" },
  ])("fails closed", (override) =>
    expect(
      () => new Provider({}, { ...options, ...override } as Options)
    ).toThrow()
  )
})
describe("native provider lifecycle", () => {
  it("creates public-safe gateway session from trusted totals", async () => {
    const result = await provider.initiatePayment({
      amount: "123.45",
      currency_code: "inr",
      context: { idempotency_key: "payses_123" },
    })
    expect(result.data).toMatchObject(data)
    expect(JSON.stringify(result)).not.toContain(options.key_secret)
    expect(request).toHaveBeenCalledWith(
      "orders",
      expect.objectContaining({
        amount: 12345,
        currency: "INR",
        notes: { medusa_payment_session_id: "payses_123" },
      })
    )
  })
  it("requires native initiation identity", async () =>
    expect(
      provider.initiatePayment({ amount: 1, currency_code: "inr" })
    ).rejects.toThrow())
  it("verifies browser return using stored order and native client data", async () => {
    const result = await provider.updatePayment({
      data: {
        ...data,
        client: {
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: sign("order_123|pay_123"),
        },
      },
      amount: 123.45,
      currency_code: "inr",
    })
    expect(result.data.payment_id).toBe("pay_123")
  })
  it("rejects a swapped callback order", async () =>
    expect(
      provider.updatePayment({
        data: {
          ...data,
          client: {
            razorpay_order_id: "order_bad",
            razorpay_payment_id: "pay_123",
          },
        },
        amount: 123.45,
        currency_code: "inr",
      })
    ).rejects.toThrow())
  it("rejects changed native totals", async () =>
    expect(
      provider.updatePayment({ data, amount: 124, currency_code: "inr" })
    ).rejects.toThrow())
  it.each([{ amount: 1 }, { currency: "USD" }, { order_id: "order_foreign" }])(
    "rejects mismatched gateway payment",
    async (override) => {
      request.mockImplementation(async (path: string) =>
        path === "orders/order_123" ? order : { ...payment, ...override }
      )
      await expect(
        provider.authorizePayment({ data: { ...data, payment_id: "pay_123" } })
      ).rejects.toThrow()
    }
  )
  it("rejects mismatched session association", async () => {
    request.mockResolvedValue({
      ...order,
      notes: { medusa_payment_session_id: "payses_other" },
    })
    await expect(provider.authorizePayment({ data })).rejects.toThrow()
  })
  it("authorizes only captured funds without another capture POST", async () => {
    expect((await provider.authorizePayment({ data })).status).toBe("captured")
    await provider.capturePayment({ data })
    expect(request.mock.calls.every((c) => c.length === 1)).toBe(true)
  })
  it("waits while automatic capture is pending", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123"
        ? order
        : { items: [{ ...payment, status: "authorized" }] }
    )
    expect((await provider.authorizePayment({ data })).status).toBe("pending")
    await expect(provider.capturePayment({ data })).rejects.toThrow()
  })
  it("returns pending without a successful attempt", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123" ? order : { items: [] }
    )
    expect((await provider.getPaymentStatus({ data })).status).toBe("pending")
  })
  it("rejects multiple successful payment attempts", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123" ? order : { items: [payment, payment] }
    )
    await expect(provider.authorizePayment({ data })).rejects.toThrow()
  })
  it("retrieves native public payment data", async () =>
    expect((await provider.retrievePayment({ data })).data.payment_id).toBe(
      "pay_123"
    ))
  it("blocks cancel/delete of a payment in progress", async () => {
    await expect(provider.cancelPayment({ data })).rejects.toThrow()
    await expect(provider.deletePayment({ data })).rejects.toThrow()
  })
  it("allows deletion of an unpaid session", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123" ? order : { items: [] }
    )
    expect((await provider.deletePayment({ data })).data).toEqual(data)
  })
  it("uses a stable gateway idempotency header for native refunds", async () => {
    await provider.refundPayment({
      data,
      amount: 1,
      context: { idempotency_key: "refund_operation" },
    })
    await provider.refundPayment({
      data,
      amount: { value: "1", precision: 20 },
      context: { idempotency_key: "refund_operation" },
    })
    const calls = request.mock.calls.filter((c) => c[0].endsWith("/refund"))
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0][1]).toEqual({ amount: 100, speed: "normal" })
    expect(calls[0][2]["X-Refund-Idempotency"]).toMatch(/^[a-f0-9]{64}$/)
  })
  it("fails closed without a refund operation key", async () =>
    expect(provider.refundPayment({ data, amount: 1 })).rejects.toThrow())
  it("rejects oversized refunds", async () =>
    expect(
      provider.refundPayment({
        data,
        amount: 999,
        context: { idempotency_key: "refund" },
      })
    ).rejects.toThrow())
  it("propagates ambiguous refund outcome and does not automatically retry", async () => {
    request.mockImplementation(async (path: string) => {
      if (path === "orders/order_123") return order
      if (path.endsWith("/payments")) return { items: [payment] }
      throw new Error("timeout")
    })
    await expect(
      provider.refundPayment({
        data,
        amount: 1,
        context: { idempotency_key: "refund" },
      })
    ).rejects.toThrow("timeout")
    expect(
      request.mock.calls.filter((c) => c[0].endsWith("/refund"))
    ).toHaveLength(1)
  })
})
describe("signed webhook replay", () => {
  const payload = (event: string) => {
    const raw = Buffer.from(
      JSON.stringify({
        event,
        payload: { payment: { entity: { id: "pay_123" } } },
      })
    )
    return {
      rawData: raw,
      data: {},
      headers: {
        "x-razorpay-signature": sign(raw.toString(), options.webhook_secret),
        "x-razorpay-event-id": "evt_123",
      },
    }
  }
  it("maps duplicates/out-of-order events to current captured state", async () => {
    const a = await provider.getWebhookActionAndData(
      payload("payment.captured")
    )
    const b = await provider.getWebhookActionAndData(
      payload("payment.authorized")
    )
    expect(a).toEqual({
      action: "captured",
      data: { session_id: "payses_123", amount: 123.45 },
    })
    expect(b).toEqual(a)
  })
  it("rejects invalid raw-body signatures", async () => {
    const p = payload("payment.captured")
    p.rawData = Buffer.from("{}")
    await expect(provider.getWebhookActionAndData(p)).rejects.toThrow()
  })
  it("ignores unsupported events", async () =>
    expect(
      await provider.getWebhookActionAndData(payload("payment.failed"))
    ).toEqual({ action: "not_supported" }))
  it("ignores foreign gateway orders", async () => {
    request.mockImplementation(async (path: string) =>
      path.startsWith("payments/") ? payment : { ...order, notes: {} }
    )
    expect(
      await provider.getWebhookActionAndData(payload("payment.captured"))
    ).toEqual({ action: "not_supported" })
  })
})
describe("gateway transport", () => {
  it("makes one bounded request and hides response secrets in errors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("secret", { status: 500 }))
    await expect(
      new RazorpayGateway(options.key_id, options.key_secret).request(
        "orders",
        {}
      )
    ).rejects.toThrow("reconcile")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      method: "POST",
    })
    fetchMock.mockRestore()
  })
})
