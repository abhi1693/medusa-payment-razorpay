import { operatorRecoveryExecution } from "../src/operator-recovery-context"
import { OperatorRefundRecoveryRequiredError } from "../src/operator-recovery-required-error"
import {
  assessRazorpayRefundRecovery,
  recoverRazorpayRefund,
  type RefundRecoveryControl,
} from "../src/operator-recovery"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { MedusaError } from "@medusajs/framework/utils"
import { PendingRefundRecoveryError } from "../src/refund-recovery-error"
import { createHash } from "node:crypto"
import { importRazorpayRefund as automaticImport } from "../src/refund-import"
import RazorpayProvider from "../src/service"
// Legacy stage-recovery cases exercise importer internals under a controlled test scope.
const importRazorpayRefund: typeof automaticImport = (scope, event, options) =>
  operatorRecoveryExecution.run(
    { session_id: "payses_native", gateway_refund_id: event.refund_id },
    () => automaticImport(scope, event, options)
  )
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
    listRefunds: vi.fn(async () => [
      ...native.refunds,
      ...(native.failed_attempts || []),
    ]),
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
      const restored = native.failed_attempts?.find(
        (r: any) => r.idempotency_key === input.idempotency_key
      )
      if (restored) {
        native.failed_attempts = native.failed_attempts.filter(
          (r: any) => r !== restored
        )
        native.refunds.push({
          ...restored,
          status: "succeeded",
          deleted_at: undefined,
        })
      } else
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
    updateOrders: async (input: any) => {
      order.metadata = input[0].metadata
    },
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
    medusa_payment_session_id: "payses_native",
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
  order.summary.pending_difference = 1
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "accounting is incomplete"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
})

it("defers a recent pending reservation without deleting or duplicating it", async () => {
  native.refunds = [
    {
      id: "refund_waiting",
      amount: "10.00",
      status: "pending",
      idempotency_key: "razorpay-observed:rfnd_external",
      metadata: {
        razorpay_import: {
          credit_paise: 1000,
          gateway_refund_id: "rfnd_external",
          gateway_payment_id: "pay_gateway",
          order_id: "order_native",
          amount_paise: 1000,
        },
      },
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

it.each(["pending", "canceled"])(
  "pays an existing credit on %s orders without duplicate or zero credit records",
  async (status) => {
    order.status = status
    order.summary.pending_difference = -10
    await importRazorpayRefund(scope, event, options)
    await importRazorpayRefund(scope, event, options)
    expect(native.refunds).toHaveLength(1)
    expect(order.transactions).toHaveLength(1)
    expect(order.credit_lines).toHaveLength(0)
    expect(order.changes || []).toHaveLength(0)
    expect(emitted).toHaveLength(1)
    expect(
      order.metadata.razorpay_refund_notifications[native.refunds[0].id]
    ).toBe(true)
    expect(posts).toBe(0)
  }
)
it("credits only the part exceeding an existing owed balance", async () => {
  order.summary.pending_difference = -4
  await importRazorpayRefund(scope, event, options)
  expect(order.credit_lines[0].amount).toBe("6.00")
  expect(native.refunds[0].metadata.razorpay_import.credit_paise).toBe(600)
})
it("does not create new credit on a canceled order", async () => {
  order.status = "canceled"
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "Canceled order"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
  expect(order.transactions).toHaveLength(0)
})

it.each(["processed", "failed"])(
  "reconciles a native pending request that later becomes %s without another gateway debit",
  async (status) => {
    native.failed_attempts = [
      {
        id: "refund_original",
        idempotency_key: "original_operation",
        amount: 10,
        status: "failed",
        deleted_at: new Date().toISOString(),
      },
    ]
    refunds[0].notes = {
      medusa_refund_key: createHash("sha256")
        .update("order_gateway:original_operation")
        .digest("hex"),
      medusa_payment_session_id: "payses_native",
    }
    refunds[0].status = "pending"
    expect((await importRazorpayRefund(scope, event, options)).status).toBe(
      "pending"
    )
    expect(native.refunds).toHaveLength(0)
    refunds[0].status = status
    if (status === "failed") gateway.amount_refunded = 0
    await importRazorpayRefund(scope, event, options)
    await importRazorpayRefund(scope, event, options)
    expect(native.failed_attempts).toHaveLength(1)
    expect(native.refunds).toHaveLength(status === "processed" ? 1 : 0)
    expect(order.transactions).toHaveLength(status === "processed" ? 1 : 0)
    expect(order.credit_lines).toHaveLength(status === "processed" ? 1 : 0)
    if (status === "processed")
      expect(
        native.refunds[0].metadata.razorpay_import.original_native_refund_id
      ).toBe("refund_original")
    expect(posts).toBe(0)
  }
)
it("defers an in-flight native operation rather than adopting it as an external refund", async () => {
  native.failed_attempts = [
    {
      id: "refund_original",
      idempotency_key: "original_operation",
      amount: 10,
      status: "pending",
    },
  ]
  refunds[0].notes = {
    medusa_refund_key: createHash("sha256")
      .update("order_gateway:original_operation")
      .digest("hex"),
    medusa_payment_session_id: "payses_native",
  }
  await expect(
    importRazorpayRefund(scope, event, options)
  ).rejects.toBeInstanceOf(OperatorRefundRecoveryRequiredError)
  expect(posts).toBe(0)
})

it("restores a failed canonical attempt with its original frozen credit intent", async () => {
  payments.refundPayment.mockImplementationOnce(async (input: any) => {
    native.failed_attempts = [
      {
        ...input,
        id: "refund_failedImport",
        amount: input.amount,
        metadata: input.metadata,
        status: "failed",
        deleted_at: new Date().toISOString(),
      },
    ]
    throw Error("Interrupted provider acknowledgement")
  })
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "Interrupted"
  )
  order.summary.pending_difference = -4
  await importRazorpayRefund(scope, event, options)
  expect(native.refunds).toHaveLength(1)
  expect(native.refunds[0].id).toBe("refund_failedImport")
  expect(order.credit_lines[0].amount).toBe("10.00")
  expect(native.refunds[0].metadata.razorpay_import.credit_paise).toBe(1000)
  expect(posts).toBe(0)
})

it("preserves the original actor, reason and note on a processed deferred native refund", async () => {
  native.failed_attempts = [
    {
      id: "refund_original",
      idempotency_key: "original",
      amount: 10,
      status: "failed",
      deleted_at: new Date().toISOString(),
      created_by: "user_fixture",
      refund_reason_id: "refres_fixture",
      note: "Original authorized refund",
    },
  ]
  refunds[0].notes = {
    medusa_refund_key: createHash("sha256")
      .update("order_gateway:original")
      .digest("hex"),
    medusa_payment_session_id: "payses_native",
  }
  await importRazorpayRefund(scope, event, options)
  expect(payments.refundPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      created_by: "user_fixture",
      refund_reason_id: "refres_fixture",
      note: "Original authorized refund",
    })
  )
})

it.each([{}, { pending_difference: null }])(
  "rejects missing native accounting summary %j before writes",
  async (summary) => {
    order.summary = summary
    await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow()
    expect(payments.refundPayment).not.toHaveBeenCalled()
    expect(order.transactions).toHaveLength(0)
    expect(posts).toBe(0)
  }
)
it("rejects duplicated gateway operation hashes before native writes", async () => {
  const hash = createHash("sha256")
    .update("order_gateway:original_operation")
    .digest("hex")
  refunds[0].notes = {
    medusa_refund_key: hash,
    medusa_payment_session_id: "payses_native",
  }
  refunds.push({ ...refunds[0], id: "rfnd_duplicate" })
  gateway.amount_refunded = 2000
  native.failed_attempts = [
    {
      id: "refund_original",
      idempotency_key: "original_operation",
      amount: 10,
      status: "failed",
      deleted_at: new Date().toISOString(),
    },
  ]
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "Ambiguous native gateway refund operation"
  )
  expect(payments.refundPayment).not.toHaveBeenCalled()
  expect(posts).toBe(0)
})
it("rejects pending gateway state for a successful native refund", async () => {
  const hash = createHash("sha256")
    .update("order_gateway:original_operation")
    .digest("hex")
  refunds[0].notes = {
    medusa_refund_key: hash,
    medusa_payment_session_id: "payses_native",
  }
  refunds[0].status = "pending"
  native.refunds = [
    {
      id: "refund_original",
      idempotency_key: "original_operation",
      amount: 10,
      status: "succeeded",
    },
  ]
  await expect(importRazorpayRefund(scope, event, options)).rejects.toThrow(
    "Accepted native refund is not processed"
  )
  expect(posts).toBe(0)
})

describe("controlled operator recovery", () => {
  const target = {
    native_payment_id: "pay_native",
    gateway_refund_id: "rfnd_external",
  }
  beforeEach(() => {
    order.payment_collections = [{ payments: [{ id: native.id }] }]
    order.summary.refunded_total = 0
    const project = () => {
      order.credit_lines.forEach((credit: any, index: number) => {
        credit.id ||= "credit_" + index
      })
      order.summary.refunded_total = order.transactions
        .filter((t: any) => t.reference === "refund")
        .reduce((sum: number, t: any) => sum - Number(t.amount), 0)
      order.summary.pending_difference =
        order.summary.refunded_total -
        order.credit_lines.reduce(
          (sum: number, t: any) => sum + Number(t.amount),
          0
        )
    }
    const transaction = orders.addOrderTransactions
    orders.addOrderTransactions = vi.fn(async (...args: any[]) => {
      try {
        return await transaction(...args)
      } finally {
        project()
      }
    })
    const confirm = orders.confirmOrderChange
    orders.confirmOrderChange = async (...args: any[]) => {
      try {
        return await confirm(...args)
      } finally {
        project()
      }
    }
  })
  function control(
    assertQuiescent = vi.fn(async () => {})
  ): RefundRecoveryControl {
    return { withQuiescence: async (work) => work(assertQuiescent) }
  }
  it("assesses without writes and imports/rechecks exactly one financial record per stage", async () => {
    const plan = await assessRazorpayRefundRecovery(scope, target, options)
    expect(plan.status).toBe("ready")
    expect(payments.refundPayment).not.toHaveBeenCalled()
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    const result = await recoverRazorpayRefund(scope, target, options, {
      fingerprint: plan.fingerprint!,
      control: control(),
    })
    expect(result.status).toBe("complete")
    expect(result.changes_possible).toBe(true)
    expect(native.refunds).toHaveLength(1)
    expect(order.transactions).toHaveLength(1)
    expect(order.credit_lines).toHaveLength(1)
    const replay = await recoverRazorpayRefund(scope, target, options, {
      fingerprint: result.fingerprint!,
      control: control(),
    })
    expect(replay.status).toBe("complete")
    expect(replay.changes_possible).toBe(false)
    expect(posts).toBe(0)
  })
  it("binds approval to the configured mode and account key identity", async () => {
    const plan = await assessRazorpayRefundRecovery(scope, target, options)
    const changed = {
      ...options,
      mode: "live" as const,
      key_id: "rzp_live_otherfixture",
    }
    const result = await recoverRazorpayRefund(scope, target, changed, {
      fingerprint: plan.fingerprint!,
      control: control(),
    })
    expect(result.reason).toBe("stale_or_unapproved_assessment")
    expect(result.changes_possible).toBe(false)
    expect(payments.refundPayment).not.toHaveBeenCalled()
    expect(posts).toBe(0)
  })
  it("rejects a stale approved assessment before financial writes", async () => {
    const plan = await assessRazorpayRefundRecovery(scope, target, options)
    order.status = "completed"
    const result = await recoverRazorpayRefund(scope, target, options, {
      fingerprint: plan.fingerprint!,
      control: control(),
    })
    expect(result.reason).toBe("stale_or_unapproved_assessment")
    expect(payments.refundPayment).not.toHaveBeenCalled()
  })
  it("requires maintenance verification and rechecks it before execution", async () => {
    const plan = await assessRazorpayRefundRecovery(scope, target, options)
    const verify = vi.fn(async () => {})
    verify.mockRejectedValueOnce(new Error("workers still running"))
    const result = await recoverRazorpayRefund(scope, target, options, {
      fingerprint: plan.fingerprint!,
      control: control(verify),
    })
    expect(result.status).toBe("quarantined")
    expect(result.changes_possible).toBe(false)
    expect(payments.refundPayment).not.toHaveBeenCalled()
    verify.mockRejectedValueOnce(new Error("maintenance lost"))
    expect(
      (
        await recoverRazorpayRefund(scope, target, options, {
          fingerprint: plan.fingerprint!,
          control: control(verify),
        })
      ).status
    ).toBe("quarantined")
    expect(posts).toBe(0)
  })
  it.each(["pending", "succeeded"])(
    "quarantines an original native %s reservation",
    async (status) => {
      native.failed_attempts = [
        {
          id: "refund_original",
          idempotency_key: "original",
          amount: 10,
          status,
        },
      ]
      refunds[0].notes = {
        medusa_refund_key: createHash("sha256")
          .update("order_gateway:original")
          .digest("hex"),
        medusa_payment_session_id: "payses_native",
      }
      const plan = await assessRazorpayRefundRecovery(scope, target, options)
      expect(plan.status).toBe("quarantined")
      expect(payments.refundPayment).not.toHaveBeenCalled()
      expect(posts).toBe(0)
    }
  )
  it.each(["pending", "failed"])(
    "quarantines gateway %s without creating accounting",
    async (status) => {
      refunds[0].status = status
      if (status === "failed") gateway.amount_refunded = 0
      expect(
        (await assessRazorpayRefundRecovery(scope, target, options)).status
      ).toBe("quarantined")
      expect(payments.refundPayment).not.toHaveBeenCalled()
    }
  )
  it("quarantines multi-payment orders and unrelated financial history", async () => {
    order.payment_collections[0].payments.push({ id: "pay_other" })
    expect(
      (await assessRazorpayRefundRecovery(scope, target, options)).reason
    ).toBe("single_payment_order_required")
    order.payment_collections[0].payments.pop()
    order.transactions.push({
      reference: "refund",
      reference_id: "refund_unknown",
      amount: -1,
    })
    expect(
      (await assessRazorpayRefundRecovery(scope, target, options)).reason
    ).toBe("unexpected_order_refund_transactions")
    expect(posts).toBe(0)
  })
  it("quarantines unrelated pending changes without import metadata", async () => {
    order.changes = [{ id: "change_other", status: "pending" }]
    expect(
      (await assessRazorpayRefundRecovery(scope, target, options)).reason
    ).toBe("unrelated_or_excessive_order_changes")
    expect(payments.refundPayment).not.toHaveBeenCalled()
  })
  it("does not adopt anonymous refund transactions or credits on first import", async () => {
    order.transactions.push({ reference: "refund", amount: -10 })
    expect(
      (await assessRazorpayRefundRecovery(scope, target, options)).reason
    ).toBe("unexpected_order_refund_transactions")
    order.transactions = []
    order.credit_lines.push({
      id: "credit_other",
      reference: "razorpay_refund",
      amount: 10,
    })
    expect(
      (await assessRazorpayRefundRecovery(scope, target, options)).reason
    ).toBe("unexpected_import_credit")
  })
  it("reassesses partial-stage crashes instead of reporting success", async () => {
    const plan = await assessRazorpayRefundRecovery(scope, target, options)
    fail = "transaction"
    const first = await recoverRazorpayRefund(scope, target, options, {
      fingerprint: plan.fingerprint!,
      control: control(),
    })
    expect(first.status).toBe("quarantined")
    expect(first.changes_possible).toBe(true)
    const resume = await assessRazorpayRefundRecovery(scope, target, options)
    expect(resume.status).toBe("ready")
    expect(
      (
        await recoverRazorpayRefund(scope, target, options, {
          fingerprint: resume.fingerprint!,
          control: control(),
        })
      ).status
    ).toBe("complete")
    expect(order.transactions).toHaveLength(1)
    expect(order.credit_lines).toHaveLength(1)
    expect(posts).toBe(0)
  })
})

it.each(["refund", "transaction", "action"])(
  "automatic import quarantines incomplete canonical stage %s",
  async (stage) => {
    fail = stage
    await expect(automaticImport(scope, event, options)).rejects.toThrow(
      "Crash"
    )
    const count = payments.refundPayment.mock.calls.length
    await expect(automaticImport(scope, event, options)).rejects.toBeInstanceOf(
      OperatorRefundRecoveryRequiredError
    )
    expect(payments.refundPayment.mock.calls.length).toBe(count)
    expect(posts).toBe(0)
  }
)
it("automatic first import and completed replay remain idempotent", async () => {
  await automaticImport(scope, event, options)
  await automaticImport(scope, event, options)
  expect(native.refunds).toHaveLength(1)
  expect(order.transactions).toHaveLength(1)
  expect(order.credit_lines).toHaveLength(1)
})

it("automatic replay after committed credit adds no further financial records", async () => {
  fail = "credit"
  await expect(automaticImport(scope, event, options)).rejects.toThrow("Crash")
  await automaticImport(scope, event, options)
  expect(order.transactions).toHaveLength(1)
  expect(order.credit_lines).toHaveLength(1)
})
