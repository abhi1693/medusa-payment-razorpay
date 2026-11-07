import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { MedusaError } from "@medusajs/framework/utils"
import { PendingRefundRecoveryError } from "../src/refund-recovery-error"
import { createHash } from "node:crypto"
import { importRazorpayRefund } from "../src/refund-import"
import RazorpayProvider from "../src/service"
let emitted: any[],
  native: any,
  order: any,
  gateway: any,
  gatewayOrder: any,
  refunds: any[],
  provider: any,
  payments: any,
  orders: any,
  scope: any,
  options: any,
  posts: number,
  fail: string
beforeEach(() => {
  emitted = []
  posts = 0
  fail = ""
  options = {
    mode: "test",
    key_id: "rzp_test_fixture",
    key_secret: "fixture_secret",
    coordinate: vi.fn(async (_: any, work: any) => work()),
  }
  native = {
    id: "pay_native",
    provider_id: "pp_razorpay_razorpay",
    currency_code: "inr",
    amount: 40,
    payment_collection_id: "paycol_native",
    payment_session: { id: "payses_native" },
    captures: [{ amount: 40 }],
    refunds: [],
    data: {
      payment_id: "pay_gateway",
      order_id: "order_gateway",
      session_id: "payses_native",
      amount: 4000,
      currency: "INR",
    },
  }
  gateway = {
    id: "pay_gateway",
    order_id: "order_gateway",
    amount: 4000,
    currency: "INR",
    status: "captured",
    amount_refunded: 1000,
  }
  gatewayOrder = {
    id: "order_gateway",
    amount: 4000,
    currency: "INR",
    notes: { medusa_payment_session_id: "payses_native" },
  }
  refunds = [
    {
      id: "rfnd_external",
      payment_id: "pay_gateway",
      amount: 1000,
      currency: "INR",
      status: "processed",
    },
  ]
  order = {
    id: "order_native",
    currency_code: "inr",
    status: "pending",
    summary: { pending_difference: 0 },
    transactions: [],
    credit_lines: [],
  }
  provider = new RazorpayProvider(
    {},
    {
      ...options,
      refund_guard: async () => {
        throw new Error("Importer must already own outer lock")
      },
    }
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (init?.method === "POST") {
        posts++
        throw Error("Must never send refund POST")
      }
      const path = url.replace("https://api.razorpay.com/v1/", "")
      const body = path.startsWith("refunds/")
        ? refunds.find((r) => r.id === path.slice(8))
        : path.includes("/refunds?")
          ? { items: refunds }
          : path === "payments/pay_gateway"
            ? gateway
            : path === "orders/order_gateway"
              ? gatewayOrder
              : { items: [gateway] }
      return new Response(JSON.stringify(body), { status: 200 })
    })
  )
  payments = {
    retrievePayment: vi.fn(async () => native),
    listPaymentSessions: async () => [
      { id: "payses_native", payment: { id: native.id } },
    ],
    refundPayment: vi.fn(async (input: any) => {
      const output = await provider.refundPayment({
        data: native.data,
        amount: input.amount,
        context: { idempotency_key: input.idempotency_key },
      })
      native.data = output.data
      native.refunds.push({
        id: "refund_" + native.refunds.length,
        amount: input.amount,
        status: "succeeded",
        idempotency_key: input.idempotency_key,
        metadata: input.metadata,
      })
      if (fail === "refund") {
        fail = ""
        throw Error("Crash after native refund commit")
      }
    }),
  }
  orders = {
    updateOrderChanges: async (input: any) => {
      const c = order.changes.find((c: any) => c.id === input.id)
      c.metadata = input.metadata
      if (fail === "notification") {
        fail = ""
        throw Error("Crash after notification commit")
      }
    },
    listOrderChanges: async () => order.changes || [],
    createOrderChange: async (change: any) => {
      const c = {
        ...change,
        id: "ordch_import",
        version: 2,
        status: "pending",
        actions: [],
      }
      ;(order.changes ||= []).push(c)
      if (fail === "change") {
        fail = ""
        throw Error("Crash after change commit")
      }
      return c
    },
    addOrderAction: async (actions: any[]) => {
      order.changes[0].actions.push(...actions)
      if (fail === "action") {
        fail = ""
        throw Error("Crash after action commit")
      }
    },
    confirmOrderChange: async () => {
      const change = order.changes[0]
      change.status = "confirmed"
      order.credit_lines.push(...change.actions)
      if (fail === "credit") {
        fail = ""
        throw Error("Crash after credit commit")
      }
    },
    retrieveOrder: async () => order,
    listOrderTransactions: async (f: any) =>
      order.transactions.filter((t: any) => t.reference_id === f.reference_id),
    addOrderTransactions: vi.fn(async (t: any) => {
      order.transactions.push(t)
      if (fail === "transaction") {
        fail = ""
        throw Error("Crash after transaction commit")
      }
    }),
    createOrderCreditLines: vi.fn(async (lines: any) => {
      order.credit_lines.push(...lines)
      if (fail === "credit") {
        fail = ""
        throw Error("Crash after credit commit")
      }
    }),
  }
  scope = {
    resolve: (key: string) =>
      key === "payment"
        ? payments
        : key === "order"
          ? orders
          : key === "event_bus"
            ? {
                emit: async (event: any) => {
                  emitted.push(event)
                  if (fail === "event") {
                    fail = ""
                    throw Error("Crash after event enqueue")
                  }
                },
              }
            : {
                graph: async (input: any) => ({
                  data:
                    input.entity === "order"
                      ? [order]
                      : [{ order: { id: order.id } }],
                }),
              },
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const event = { refund_id: "rfnd_external", payment_id: "pay_gateway" }
it("imports partial processed funds once without a gateway POST and with exact native references", async () => {
  expect((await importRazorpayRefund(scope, event, options)).status).toBe(
    "imported"
  )
  await importRazorpayRefund(scope, event, options)
  expect(native.refunds).toHaveLength(1)
  expect(order.transactions).toHaveLength(1)
  expect(order.credit_lines).toHaveLength(1)
  expect(order.transactions[0].amount).toBe("-10.00")
  expect(order.credit_lines[0].amount).toBe("10.00")
  expect(posts).toBe(0)
})
it.each(["refund", "transaction", "change", "action", "credit"])(
  "recovers crash after %s commit with one financial record per stage",
  async (stage) => {
    fail = stage
    await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
      "Crash"
    )
    await importRazorpayRefund(scope, event, options)
    expect(native.refunds).toHaveLength(1)
    expect(order.transactions).toHaveLength(1)
    expect(order.credit_lines).toHaveLength(1)
    expect(posts).toBe(0)
  }
)
it("imports and replays the full balance without the native workflow's pre-replay cap", async () => {
  gateway.amount_refunded = refunds[0].amount = 4000
  await importRazorpayRefund(scope, event, options)
  await importRazorpayRefund(scope, event, options)
  expect(native.refunds).toHaveLength(1)
  expect(order.transactions[0].amount).toBe("-40.00")
  expect(posts).toBe(0)
})
it.each(["pending", "failed"])(
  "observes external %s without changing native accounting",
  async (status) => {
    refunds[0].status = status
    expect((await importRazorpayRefund(scope, event, options)).status).toBe(
      status
    )
    expect(payments.refundPayment).not.toHaveBeenCalled()
    expect(order.transactions).toHaveLength(0)
    expect(posts).toBe(0)
  }
)
it("handles pending then processed, duplicated speed changes, and out-of-order pending notification using fetched state", async () => {
  refunds[0].status = "pending"
  await importRazorpayRefund(scope, event, options)
  refunds[0].status = "processed"
  await importRazorpayRefund(scope, event, options)
  await importRazorpayRefund(scope, event, options)
  expect(native.refunds).toHaveLength(1)
})
it.each(["currency", "amount", "payment", "order", "session"])(
  "rejects spoofed %s before native mutation",
  async (kind) => {
    if (kind === "currency") refunds[0].currency = "USD"
    if (kind === "amount") refunds[0].amount = 4001
    if (kind === "payment") refunds[0].payment_id = "pay_other"
    if (kind === "order") gatewayOrder.id = "order_other"
    if (kind === "session")
      gatewayOrder.notes.medusa_payment_session_id = "payses_other"
    await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow()
    expect(payments.refundPayment).not.toHaveBeenCalled()
    expect(posts).toBe(0)
  }
)
it("does not adopt a native-origin refund even before the native operation commits", async () => {
  refunds[0].notes = { medusa_refund_key: "opaque" }
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "not committed"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
})
it("recognizes native operation identity and flags later failure without fabricating reversal", async () => {
  native.refunds = [
    {
      id: "refund_native",
      amount: 10,
      status: "succeeded",
      idempotency_key: "native_key",
    },
  ]
  refunds[0].notes = {
    medusa_refund_key: createHash("sha256")
      .update("order_gateway:native_key")
      .digest("hex"),
  }
  expect((await importRazorpayRefund(scope, event, options)).status).toBe(
    "native"
  )
  refunds[0].status = "failed"
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "accounting review"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
})
it("refuses ambiguous native history and unbalanced order accounting", async () => {
  native.refunds = [{ id: "refund_unknown", amount: 1, status: "succeeded" }]
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "lacks a verified"
  )
  native.refunds = []
  order.summary.pending_difference = -1
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "accounting is incomplete"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
})

it("retains a pending native reservation for review instead of deleting or duplicating it", async () => {
  native.refunds = [
    {
      id: "refund_waiting",
      amount: "10.00",
      status: "pending",
      idempotency_key: "razorpay-observed:rfnd_external",
      metadata: { razorpay_import: { credit_paise: 1000 } },
    },
  ]
  payments.refundPayment.mockRejectedValue(
    new MedusaError(MedusaError.Types.CONFLICT, "in progress")
  )
  await expect(
    importRazorpayRefund(scope, event, options)
  ).rejects.toBeInstanceOf(PendingRefundRecoveryError)
  expect(payments.refundPayment).toHaveBeenCalledTimes(1)
  expect(order.transactions).toHaveLength(0)
  expect(posts).toBe(0)
})
it("refuses totals disagreement and malformed event identity", async () => {
  gateway.amount_refunded = 999
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "totals are inconsistent"
  )
  await expect(
    importRazorpayRefund(scope, { ...event, refund_id: "../refund" }, options)
  ).rejects.toThrow("identity")
  expect(payments.refundPayment).not.toHaveBeenCalled()
})
it("ignores uncaptured automatic refunds without fabricating native payments", async () => {
  gateway.captured = false
  expect((await importRazorpayRefund(scope, event, options)).status).toBe(
    "ignored"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
})
it("rejects persisted intent and duplicate accounting mismatches", async () => {
  await importRazorpayRefund(scope, event, options)
  native.refunds[0].metadata.razorpay_import.amount_paise = 1
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "intent mismatch"
  )
  native.refunds[0].metadata.razorpay_import.amount_paise = 1000
  order.transactions.push({ ...order.transactions[0] })
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "transaction mismatch"
  )
  expect(posts).toBe(0)
})

it("emits the native refund event after accounting and checkpoints normal duplicate delivery", async () => {
  await importRazorpayRefund(scope, event, options)
  await importRazorpayRefund(scope, event, options)
  expect(emitted).toHaveLength(1)
  expect(emitted[0]).toMatchObject({
    name: "payment.refunded",
    data: {
      id: "pay_native",
      gateway_refund_id: "rfnd_external",
      refund_id: native.refunds[0].id,
    },
  })
  expect(order.changes[0].metadata.razorpay_refund_event_emitted).toBe(true)
})
it.each(["event", "notification"])(
  "recovers %s publication interruption without duplicate accounting",
  async (stage) => {
    fail = stage
    await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
      "Crash"
    )
    await importRazorpayRefund(scope, event, options)
    expect(native.refunds).toHaveLength(1)
    expect(order.transactions).toHaveLength(1)
    expect(order.credit_lines).toHaveLength(1)
    // An enqueue/marker crash may redeliver the same notification, never funds.
    expect(emitted).toHaveLength(stage === "event" ? 2 : 1)
  }
)
it("requires fresh cross-worker native reads", async () => {
  await importRazorpayRefund(scope, event, options)
  expect(payments.retrievePayment).toHaveBeenCalledWith(
    "pay_native",
    expect.objectContaining({ options: { refresh: true } })
  )
})
