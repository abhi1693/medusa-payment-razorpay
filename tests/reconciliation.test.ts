import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"
import { reconcileRazorpayPayment as reconcile } from "../src/reconciliation"
const config = () => ({
  mode: process.env.RAZORPAY_MODE as "test",
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})
const reconcileRazorpayPayment = (scope: MedusaContainer, id: string) =>
  reconcile(scope, id, config())
let native: any,
  gateway: any,
  order: any,
  refunds: any[],
  fetcher: any,
  scope: MedusaContainer
beforeEach(() => {
  vi.stubEnv("RAZORPAY_MODE", "test")
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_fixture")
  vi.stubEnv("RAZORPAY_KEY_SECRET", "fixture_secret")
  native = {
    id: "pay_native",
    provider_id: "pp_razorpay_razorpay",
    currency_code: "inr",
    payment_session: { id: "payses_fixture" },
    amount: 123.45,
    data: {
      payment_id: "pay_gateway",
      order_id: "order_gateway",
      session_id: "payses_fixture",
      amount: 12345,
      currency: "INR",
    },
    captures: [{ amount: 123.45 }],
    refunds: [],
  }
  gateway = {
    id: "pay_gateway",
    order_id: "order_gateway",
    amount: 12345,
    currency: "INR",
    status: "captured",
    amount_refunded: 0,
  }
  order = {
    id: "order_gateway",
    amount: 12345,
    currency: "INR",
    notes: { medusa_payment_session_id: "payses_fixture" },
  }
  refunds = []
  scope = {
    resolve: () => ({ retrievePayment: async () => native }),
  } as unknown as MedusaContainer
  fetcher = vi.fn(async (url: string, init: any) => {
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("error")
    const body = url.includes("/refunds?")
      ? { items: refunds }
      : url.includes("/orders/")
        ? order
        : gateway
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
it("verifies trusted bindings and exact INR amounts without monetary requests", async () => {
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.amount_paise).toBe(12345)
  expect(result.native_captured_paise).toBe(12345)
  expect(result.discrepancies).toEqual([])
  expect(result.complete).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(result)).not.toContain("fixture_secret")
})
it.each(["payment", "order", "amount", "currency", "session"])(
  "rejects spoofed gateway %s binding",
  async (kind) => {
    if (kind === "payment") gateway.id = "pay_other"
    if (kind === "order") gateway.order_id = "order_other"
    if (kind === "amount") gateway.amount = 12344
    if (kind === "currency") gateway.currency = "USD"
    if (kind === "session")
      order.notes.medusa_payment_session_id = "payses_other"
    await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
      "binding mismatch"
    )
  }
)
it.each(["system", "currency", "amount", "fraction"])(
  "rejects unsupported native %s before gateway access",
  async (kind) => {
    if (kind === "system") native.provider_id = "pp_system_default"
    if (kind === "currency") native.currency_code = "usd"
    if (kind === "amount") native.amount = 1
    if (kind === "fraction") native.amount = "123.456"
    await expect(
      reconcileRazorpayPayment(scope, "pay_native")
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  }
)
it("reports full and partial refund balances in paise", async () => {
  native.refunds = [{ id: "ref_one", amount: 10, status: "succeeded" }]
  refunds = [
    {
      id: "rfnd_one",
      payment_id: "pay_gateway",
      amount: 1000,
      currency: "INR",
      status: "processed",
    },
  ]
  gateway.amount_refunded = 1000
  let result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.native_refunded_paise).toBe(1000)
  expect(result.discrepancies).toEqual([])
  native.refunds[0].amount = 123.45
  refunds[0].amount = 12345
  gateway.amount_refunded = 12345
  result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.gateway_accepted_refunded_paise).toBe(12345)
  expect(result.discrepancies).toEqual([])
})
it.each(["foreign", "currency", "status", "amount", "duplicate"])(
  "rejects unauthentic %s refund records",
  async (kind) => {
    const refund = {
      id: "rfnd_one",
      payment_id: "pay_gateway",
      amount: 1000,
      currency: "INR",
      status: "processed",
    }
    if (kind === "foreign") refund.payment_id = "pay_other"
    if (kind === "currency") refund.currency = "USD"
    if (kind === "status") refund.status = "unknown"
    if (kind === "amount") refund.amount = 12346
    refunds = [refund]
    if (kind === "duplicate") refunds.push({ ...refund })
    await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
      "invalid associations"
    )
  }
)
it("flags external refunds and pending or failed processing rather than changing native records", async () => {
  refunds = [
    {
      id: "rfnd_one",
      payment_id: "pay_gateway",
      amount: 1000,
      currency: "INR",
      status: "pending",
    },
  ]
  gateway.amount_refunded = 1000
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.discrepancies).toContain(
    "Native refund total differs from gateway pending/processed refund total"
  )
  expect(native.refunds).toEqual([])
})
it("sanitizes unavailable payment lookup HTTP 400 without leaking response bodies", async () => {
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ error: { description: "private diagnostics" } }),
      { status: 400 }
    )
  )
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "HTTP 400"
  )
})
it.each(["live", "unknown"])("never accesses %s mode", async (mode) => {
  vi.stubEnv("RAZORPAY_MODE", mode)
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Test gateway configuration"
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it("rejects malformed native identifiers without exposing records", async () => {
  await expect(reconcileRazorpayPayment(scope, "../pay")).rejects.toThrow(
    "Payment not found"
  )
  expect(fetcher).not.toHaveBeenCalled()
})
it("requires a test key and private configuration before gateway reads", async () => {
  vi.stubEnv("RAZORPAY_KEY_ID", "")
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Test gateway"
  )
  expect(fetcher).not.toHaveBeenCalled()
})
it("requires the configured private secret", async () => {
  vi.stubEnv("RAZORPAY_KEY_SECRET", "")
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Test gateway"
  )
})
it("fails safely when the configured test key has live prefix", async () => {
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_fixture")
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Test gateway"
  )
})
it("does not start a gateway read after its report deadline", async () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(40000)
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "timed out"
  )
  expect(fetcher).not.toHaveBeenCalled()
})
it("rejects unsupported native amount ranges rather than rounding them", async () => {
  native.amount = "9007199254740991"
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "supported range"
  )
})
it.each([undefined, -1, 1.2])(
  "rejects malformed gateway refunded amount %s",
  async (value) => {
    gateway.amount_refunded = value
    await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
      "Invalid gateway INR"
    )
  }
)
it("rejects a malformed refund page rather than reporting no refunds", async () => {
  fetcher.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/refunds?")
            ? { items: null }
            : url.includes("/orders/")
              ? order
              : gateway
        )
      )
  )
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "refund listing"
  )
})
it("reports failed gateway refunds, unsettled native rows and missing latest identities", async () => {
  refunds = [
    {
      id: "rfnd_failed",
      payment_id: "pay_gateway",
      amount: 100,
      currency: "INR",
      status: "failed",
    },
  ]
  native.refunds = [{ id: "ref_pending", amount: 1, status: undefined }]
  native.data.last_refund_id = "rfnd_missing"
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.discrepancies).toContain(
    "Latest native gateway refund ID is absent from this gateway payment"
  )
  expect(result.discrepancies).toContain(
    "Gateway contains failed refunds; inspect their native association manually"
  )
  expect(result.discrepancies).toContain(
    "Native refund processing is not settled"
  )
})
it("reports mismatching payment aggregate and over-bound refund totals", async () => {
  refunds = [
    {
      id: "rfnd_one",
      payment_id: "pay_gateway",
      amount: 10000,
      currency: "INR",
      status: "processed",
    },
    {
      id: "rfnd_two",
      payment_id: "pay_gateway",
      amount: 10000,
      currency: "INR",
      status: "pending",
    },
  ]
  gateway.amount_refunded = 12346
  native.data.last_refund_id = "bad"
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.latest_gateway_refund_id).toBeNull()
  expect(result.discrepancies).toContain(
    "Gateway refunded amount exceeds the bound payment amount"
  )
  expect(result.discrepancies).toContain(
    "Gateway payment refund total differs from listed accepted refunds"
  )
})
it("bounds pagination and never claims an incomplete refund list is complete", async () => {
  let page = 0
  native.amount = 10000
  native.data.amount = 1000000
  gateway.amount = 1000000
  order.amount = 1000000
  fetcher.mockImplementation(async (url: string) => {
    let value: any = url.includes("/orders/") ? order : gateway
    if (url.includes("/refunds?")) {
      value = {
        items: Array.from({ length: 100 }, (_, i) => ({
          id: "rfnd_page" + (page * 100 + i),
          payment_id: "pay_gateway",
          amount: 100,
          currency: "INR",
          status: "processed",
        })),
      }
      page++
    }
    return new Response(JSON.stringify(value))
  })
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(page).toBe(5)
  expect(result.complete).toBe(false)
  expect(result.gateway_refunds).toHaveLength(500)
  expect(result.discrepancies).toContain(
    "Gateway refund list exceeds the report limit"
  )
})
it("supports native records without populated optional relations", async () => {
  delete native.refunds
  delete native.captures
  const result = await reconcileRazorpayPayment(scope, "pay_native")
  expect(result.native_captured_paise).toBe(0)
  expect(result.native_refunds).toEqual([])
})
it("rejects aggregate overflow instead of truncating accounting totals", async () => {
  native.captures = [{ amount: "90071992547409.91" }, { amount: 1 }]
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Total exceeds supported range"
  )
})

it("refuses native records whose amount is absent before any gateway read", async () => {
  native.amount = undefined
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Invalid"
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it("accepts a consumer-specific native provider registration ID", async () => {
  native.provider_id = "pp_razorpay_anotherstore"
  const report = await reconcile(scope, "pay_native", {
    ...config(),
    provider_id: "pp_razorpay_anotherstore",
  })
  expect(report.discrepancies).toEqual([])
})

it("reports refund speed metadata without treating speed changes as settlement", async () => {
  native.refunds = [{ id: "ref_fixture", amount: 1, status: "succeeded" }]
  refunds = [
    {
      id: "rfnd_fixture",
      payment_id: "pay_gateway",
      amount: 100,
      currency: "INR",
      status: "pending",
      speed_requested: "optimum",
      speed_processed: "normal",
    },
  ]
  gateway.amount_refunded = 100
  const report = await reconcileRazorpayPayment(scope, "pay_native")
  expect(report.gateway_refunds[0]).toMatchObject({
    status: "pending",
    speed_requested: "optimum",
    speed_processed: "normal",
  })
  expect(report.gateway_accepted_refunded_paise).toBe(100)
  expect(native.refunds[0].status).toBe("succeeded")
  expect(
    fetcher.mock.calls.every(([, init]: any) => init.method === "GET")
  ).toBe(true)
})

it("rejects stored data bound to a different native payment session", async () => {
  native.payment_session.id = "payses_other"
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "supported bound"
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it("rejects whitespace-only account secrets before an authenticated read", async () => {
  vi.stubEnv("RAZORPAY_KEY_SECRET", "   ")
  await expect(reconcileRazorpayPayment(scope, "pay_native")).rejects.toThrow(
    "Test gateway"
  )
  expect(fetcher).not.toHaveBeenCalled()
})
