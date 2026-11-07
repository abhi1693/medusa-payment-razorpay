import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHash, createHmac } from "node:crypto"
import { BigNumber } from "@medusajs/framework/utils"
import Provider, { type Options } from "../src/service"
import { minor, verify, verifyRazorpayCheckout } from "../src/security"
import { RazorpayGateway } from "../src/gateway"
const options: Options = {
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
type GatewayCall = (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => Promise<unknown>
class TestProvider extends Provider {
  setGateway(api: {
    get: (path: string) => Promise<unknown>
    post: GatewayCall
  }): void {
    this.api = {
      get: async <T>(path: string): Promise<T> => (await api.get(path)) as T,
      post: async <T>(
        path: string,
        body: unknown,
        headers?: Record<string, string>
      ): Promise<T> => (await api.post(path, body, headers)) as T,
    }
  }
}
let provider: TestProvider
let request: ReturnType<typeof vi.fn<GatewayCall>>
beforeEach(() => {
  request = vi.fn<GatewayCall>(async (path: string) => {
    if (path === "orders/order_123") return order
    if (path === "orders/order_123/payments") return { items: [payment] }
    if (path === "payments/pay_123") return payment
    if (path.startsWith("payments/pay_123/refunds?")) return { items: [] }
    if (path === "orders") return order
    if (path === "payments/pay_123/refund")
      return {
        id: "rfnd_123",
        payment_id: "pay_123",
        amount: 100,
        currency: "INR",
        status: "processed",
      }
    throw new Error("Unexpected request " + path)
  })
  provider = new TestProvider({}, options)
  provider.setGateway({
    get: (path) => request(path),
    post: (path, body, headers) =>
      headers === undefined
        ? request(path, body)
        : request(path, body, headers),
  })
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
it("allows basic registration without webhook setup and fails closed for delivery", async () => {
  const basic = new TestProvider({}, { ...options, webhook_secret: undefined })
  await expect(
    basic.getWebhookActionAndData({
      rawData: Buffer.from("{}"),
      data: {},
      headers: {},
    })
  ).rejects.toThrow("webhooks are not configured")
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
    expect(request.mock.calls.every((c) => c[1] === undefined)).toBe(true)
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
    expect(calls[0][1]).toMatchObject({
      amount: 100,
      speed: "normal",
      notes: { medusa_payment_session_id: data.session_id },
    })
    expect(calls[0][2]?.["X-Refund-Idempotency"]).toMatch(/^[a-f0-9]{64}$/)
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
      if (path.includes("/refunds?")) return { items: [] }
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
      new RazorpayGateway({
        key_id: options.key_id,
        key_secret: options.key_secret,
      }).request("orders", {})
    ).rejects.toThrow("reconcile")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      method: "POST",
    })
    fetchMock.mockRestore()
  })
})

describe("refund execution security boundary", () => {
  const input = {
    data,
    amount: 1,
    context: { idempotency_key: "guarded_refund" },
  }
  it("keeps all gateway verification and the refund behind the guard", async () => {
    let allow!: () => void
    let enter!: () => void
    const allowed = new Promise<void>((resolve) => {
      allow = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const guarded = new TestProvider(
      {},
      {
        ...options,
        refund_guard: async (context, execute) => {
          expect(context).toEqual({ session_id: "payses_123" })
          enter()
          await allowed
          return execute()
        },
      }
    )
    guarded.setGateway({
      get: (path) => request(path),
      post: (path, body, headers) =>
        headers === undefined
          ? request(path, body)
          : request(path, body, headers),
    })
    const operation = guarded.refundPayment(input)
    await entered
    expect(request).not.toHaveBeenCalled()
    allow()
    await expect(operation).resolves.toMatchObject({
      data: {
        last_refund_id: "rfnd_123",
        last_refund_initial_status: "processed",
      },
    })
    expect(
      request.mock.calls.filter((c) => c[0].endsWith("/refund"))
    ).toHaveLength(1)
  })
  it("makes no gateway request if coordination is rejected", async () => {
    const guarded = new TestProvider(
      {},
      {
        ...options,
        refund_guard: async () => {
          throw new Error("coordination unavailable")
        },
      }
    )
    guarded.setGateway({
      get: (path) => request(path),
      post: (path, body, headers) =>
        headers === undefined
          ? request(path, body)
          : request(path, body, headers),
    })
    await expect(guarded.refundPayment(input)).rejects.toThrow(
      "coordination unavailable"
    )
    expect(request).not.toHaveBeenCalled()
  })
  it("propagates uncertain execution once and exits the guard", async () => {
    const events: string[] = []
    const original = request.getMockImplementation()!
    request.mockImplementation(async (path: string) => {
      if (path.endsWith("/refund"))
        throw new Error("uncertain gateway response")
      return original(path)
    })
    const guarded = new TestProvider(
      {},
      {
        ...options,
        refund_guard: async (_, execute) => {
          events.push("entered")
          try {
            return await execute()
          } finally {
            events.push("exited")
          }
        },
      }
    )
    guarded.setGateway({
      get: (path) => request(path),
      post: (path, body, headers) =>
        headers === undefined
          ? request(path, body)
          : request(path, body, headers),
    })
    await expect(guarded.refundPayment(input)).rejects.toThrow(
      "uncertain gateway response"
    )
    expect(events).toEqual(["entered", "exited"])
    expect(
      request.mock.calls.filter((c) => c[0].endsWith("/refund"))
    ).toHaveLength(1)
  })
  it.each([
    { payment_id: "pay_foreign" },
    { currency: "USD" },
    { amount: 99 },
    { id: "invalid" },
    { status: "failed" },
    { status: "unknown" },
  ])(
    "rejects an unbound or unaccepted refund response %o",
    async (override) => {
      const original = request.getMockImplementation()!
      request.mockImplementation(async (path: string) =>
        path.endsWith("/refund")
          ? {
              id: "rfnd_123",
              payment_id: "pay_123",
              amount: 100,
              currency: "INR",
              status: "processed",
              ...override,
            }
          : original(path)
      )
      await expect(provider.refundPayment(input)).rejects.toThrow(
        "not accepted"
      )
      expect(
        request.mock.calls.filter((c) => c[0].endsWith("/refund"))
      ).toHaveLength(1)
    }
  )
  it.each([
    { amount: "123.45", paise: 12345 },
    { amount: "1.23", paise: 123 },
  ])("passes exact full/partial paise values %o", async (value) => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (path: string) =>
      path.endsWith("/refund")
        ? {
            id: "rfnd_123",
            payment_id: "pay_123",
            amount: value.paise,
            currency: "INR",
            status: "processed",
          }
        : original(path)
    )
    await expect(
      provider.refundPayment({ ...input, amount: value.amount })
    ).resolves.toMatchObject({
      data: { last_refund_initial_status: "processed" },
    })
    expect(request).toHaveBeenCalledWith(
      "payments/pay_123/refund",
      expect.objectContaining({ amount: value.paise, speed: "normal" }),
      expect.any(Object)
    )
  })
})

it.each([0.01, 0.5, 0.99])(
  "rejects gateway-unsupported sub-rupee refund %s before any request",
  async (amount) => {
    await expect(
      provider.refundPayment({
        data,
        amount,
        context: { idempotency_key: "minimum_fixture" },
      })
    ).rejects.toThrow("at least INR 1.00")
    expect(request).not.toHaveBeenCalled()
  }
)

describe("payment attempt identity and retry safety", () => {
  it("allows a signed retry after a terminal failed attempt on the same order", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123"
        ? order
        : path === "payments/pay_failed"
          ? { ...payment, id: "pay_failed", status: "failed" }
          : path === "payments/pay_retry"
            ? { ...payment, id: "pay_retry" }
            : undefined
    )
    const result = await provider.updatePayment({
      data: {
        ...data,
        payment_id: "pay_failed",
        client: {
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_retry",
          razorpay_signature: sign("order_123|pay_retry"),
        },
      },
      amount: 123.45,
      currency_code: "inr",
    })
    expect(result.data.payment_id).toBe("pay_retry")
    expect(result.status).toBe("captured")
  })
  it.each(["authorized", "captured", "refunded"])(
    "never silently replaces a previously %s attempt",
    async (status) => {
      request.mockImplementation(async (path: string) =>
        path === "orders/order_123" ? order : { ...payment, status }
      )
      await expect(
        provider.updatePayment({
          data: {
            ...data,
            payment_id: "pay_123",
            client: {
              razorpay_order_id: "order_123",
              razorpay_payment_id: "pay_retry",
              razorpay_signature: sign("order_123|pay_retry"),
            },
          },
          amount: 123.45,
          currency_code: "inr",
        })
      ).rejects.toThrow("already in progress or settled")
    }
  )
  it("does not mark a failed attempt paid and allows its unpaid session to be removed", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123"
        ? order
        : path === "orders/order_123/payments"
          ? { items: [] }
          : { ...payment, status: "failed" }
    )
    const input = { data: { ...data, payment_id: "pay_123" } }
    expect((await provider.getPaymentStatus(input)).status).toBe("pending")
    await expect(provider.cancelPayment(input)).resolves.toBeTruthy()
  })
  it("rejects gateway detail responses whose ID differs from the signed/requested payment", async () => {
    request.mockImplementation(async (path: string) =>
      path === "orders/order_123" ? order : { ...payment, id: "pay_other" }
    )
    await expect(
      provider.authorizePayment({ data: { ...data, payment_id: "pay_123" } })
    ).rejects.toThrow("identity mismatch")
  })
  it("rejects a webhook detail response for a different payment identity", async () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_123" } } },
      })
    )
    request.mockResolvedValue({ ...payment, id: "pay_other" })
    await expect(
      provider.getWebhookActionAndData({
        rawData: raw,
        data: {},
        headers: {
          "x-razorpay-signature": sign(raw.toString(), options.webhook_secret!),
        },
      })
    ).rejects.toThrow("identity mismatch")
  })
  it.each([0, 1.2, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe webhook amount %s",
    async (amount) => {
      const raw = Buffer.from(
        JSON.stringify({
          event: "payment.captured",
          payload: { payment: { entity: { id: "pay_123" } } },
        })
      )
      request.mockImplementation(async (path: string) =>
        path === "payments/pay_123"
          ? { ...payment, amount }
          : { ...order, amount }
      )
      await expect(
        provider.getWebhookActionAndData({
          rawData: raw,
          data: {},
          headers: {
            "x-razorpay-signature": sign(
              raw.toString(),
              options.webhook_secret!
            ),
          },
        })
      ).rejects.toThrow("webhook amount")
    }
  )
})

it("exports reusable checkout signature verification with stored identities", () => {
  verifyRazorpayCheckout(
    "order_123",
    "pay_123",
    sign("order_123|pay_123"),
    options.key_secret
  )
  expect(() =>
    verifyRazorpayCheckout(
      "order_other",
      "pay_123",
      sign("order_123|pay_123"),
      options.key_secret
    )
  ).toThrow()
  for (const [orderId, paymentId, secret] of [
    ["bad", "pay_123", options.key_secret],
    ["order_123", "bad", options.key_secret],
    ["order_123", "pay_123", ""],
  ])
    expect(() =>
      verifyRazorpayCheckout(orderId, paymentId, "bad", secret)
    ).toThrow()
})

it.each(["", "   ", undefined])(
  "public signature helpers reject missing secret %j",
  (secret) => {
    expect(() => verify("raw", "0".repeat(64), secret as any)).toThrow(
      "not configured"
    )
  }
)

describe("settlement-aware refund execution", () => {
  const input = {
    data,
    amount: 1,
    context: { idempotency_key: "settlement_operation" },
  }
  const hash = createHash("sha256")
    .update("order_123:settlement_operation")
    .digest("hex")
  const refund = (status = "processed") => ({
    id: "rfnd_existing",
    payment_id: "pay_123",
    amount: 100,
    currency: "INR",
    status,
    notes: { medusa_refund_key: hash, medusa_payment_session_id: "payses_123" },
  })
  function listed(entries: any[], detail?: any) {
    const base = request.getMockImplementation()!
    request.mockImplementation(async (path: string, ...args: any[]) =>
      path.includes("/refunds?")
        ? { items: entries }
        : path === "refunds/rfnd_existing"
          ? detail || entries[0]
          : base(path, ...args)
    )
  }
  it("acknowledges an existing processed operation with GETs and no second POST", async () => {
    listed([refund()])
    await expect(provider.refundPayment(input)).rejects.toMatchObject({
      name: "GatewayRefundReconciliationError",
      gateway_refund_id: "rfnd_existing",
    })
    expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(false)
  })
  it.each(["pending", "failed"])(
    "does not POST an existing %s operation",
    async (status) => {
      listed([refund(status)])
      await expect(provider.refundPayment(input)).rejects.toThrow(
        status === "pending" ? "is pending" : "not accepted"
      )
      expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(
        false
      )
    }
  )
  it("blocks a new operation while an external refund is pending", async () => {
    listed([{ ...refund("pending"), notes: {} }])
    await expect(provider.refundPayment(input)).rejects.toThrow(
      "Do not issue another refund"
    )
    expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(false)
  })
  it("does not report a newly accepted pending response as native success", async () => {
    const base = request.getMockImplementation()!
    request.mockImplementation(async (path: string, ...args: any[]) =>
      path.endsWith("/refund") ? refund("pending") : base(path, ...args)
    )
    await expect(provider.refundPayment(input)).rejects.toMatchObject({
      name: "GatewayRefundPendingError",
      gateway_refund_id: "rfnd_existing",
    })
    expect(
      request.mock.calls.filter((c) => c[0].endsWith("/refund"))
    ).toHaveLength(1)
  })
  it.each(["payment", "currency", "duplicate", "detail"])(
    "rejects invalid listed %s before a refund POST",
    async (kind) => {
      const entry: any = refund()
      if (kind === "payment") entry.payment_id = "pay_other"
      if (kind === "currency") entry.currency = "USD"
      listed(
        kind === "duplicate" ? [entry, entry] : [entry],
        kind === "detail" ? { ...entry, id: "rfnd_swapped" } : undefined
      )
      await expect(provider.refundPayment(input)).rejects.toThrow()
      expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(
        false
      )
    }
  )
  it("rejects changing the amount of an existing keyed operation without sending funds", async () => {
    listed([refund()])
    await expect(
      provider.refundPayment({ ...input, amount: 2 })
    ).rejects.toThrow("not accepted")
    expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(false)
  })
  it("enforces remaining gateway funds before sending another refund", async () => {
    listed([{ ...refund(), amount: 12300, notes: {} }])
    await expect(provider.refundPayment(input)).rejects.toThrow(
      "remaining gateway balance"
    )
    expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(false)
  })
  it("retains a bounded review limit for large histories", async () => {
    const base = request.getMockImplementation()!
    request.mockImplementation(async (path: string, ...args: any[]) => {
      if (path.includes("/refunds?")) {
        const skip = Number(path.split("skip=")[1])
        return {
          items: Array.from({ length: 100 }, (_, n) => ({
            ...refund(),
            id: "rfnd_page" + (skip + n),
            amount: 1,
            notes: {},
          })),
        }
      }
      return base(path, ...args)
    })
    await expect(provider.refundPayment(input)).rejects.toThrow(
      "limit exceeded"
    )
    expect(request.mock.calls.some((c) => c[0].endsWith("/refund"))).toBe(false)
  })
})
