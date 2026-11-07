import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  reconcile: vi.fn(),
  guard: vi.fn(),
}))
import {
  signedRefundEvent as parseRefund,
  observeRazorpayRefund as observe,
} from "../src/refund-observation"
const signedRefundEvent = (payload: any) =>
  parseRefund(payload, process.env.RAZORPAY_WEBHOOK_SECRET)
const observeRazorpayRefund = (scope: any, event: any) =>
  observe(scope, event, {
    get: mocks.get,
    reconcile: mocks.reconcile,
    coordinate: mocks.guard,
  })
let scope: any, sessions: any, report: any
const event = { refund_id: "rfnd_fixture", payment_id: "pay_gateway" }
function signed(value: any, serialized = false) {
  const raw = Buffer.from(JSON.stringify(value))
  return {
    rawData: serialized ? JSON.parse(JSON.stringify(raw)) : raw,
    headers: {
      "x-razorpay-signature": createHmac("sha256", "fixture")
        .update(raw)
        .digest("hex"),
    },
  }
}
const body = (name = "refund.processed") => ({
  event: name,
  payload: {
    refund: { entity: { id: event.refund_id, payment_id: event.payment_id } },
  },
})
beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "fixture")
  mocks.get.mockReset().mockImplementation(async (path: string) =>
    path.startsWith("payments/")
      ? { id: "pay_gateway", order_id: "order_gateway" }
      : {
          id: "order_gateway",
          notes: { medusa_payment_session_id: "payses_fixture" },
        }
  )
  sessions = vi.fn().mockResolvedValue([{ payment: { id: "pay_native" } }])
  scope = { resolve: () => ({ listPaymentSessions: sessions }) }
  report = {
    payment_id: "pay_native",
    gateway_payment_id: "pay_gateway",
    gateway_refunds: [{ id: "rfnd_fixture" }],
    discrepancies: [],
  }
  mocks.reconcile.mockReset().mockResolvedValue(report)
  mocks.guard.mockReset().mockImplementation(async (ids, fn) => {
    expect(ids).toEqual(["payses_fixture"])
    return fn()
  })
})
afterEach(() => vi.unstubAllEnvs())
it.each([false, true])(
  "validates exact raw bytes before observing, serialized=%s",
  (serialized) =>
    expect(signedRefundEvent(signed(body(), serialized))).toEqual(event)
)
it.each(["refund.created", "refund.failed", "refund.speed_changed"])(
  "accepts %s as a current-state observation",
  (name) => expect(signedRefundEvent(signed(body(name)))).toEqual(event)
)
it("ignores other signed event types", () =>
  expect(signedRefundEvent(signed(body("payment.captured")))).toBeNull())
it.each([
  undefined,
  {},
  { type: "Other", data: [1] },
  { type: "Buffer", data: "invalid" },
  { type: "Buffer", data: [256] },
  { type: "Buffer", data: [-1] },
  { type: "Buffer", data: [1.5] },
])("rejects missing or malformed bytes %j", (rawData) =>
  expect(() => signedRefundEvent({ rawData })).toThrow("raw webhook bytes")
)
it.each([undefined, [], "bad", "0".repeat(64)])(
  "rejects invalid signatures %j",
  (signature) => {
    const value = signed(body())
    value.headers["x-razorpay-signature"] = signature as any
    expect(() => signedRefundEvent(value)).toThrow("signature")
  }
)
it("requires a secret and headers", () => {
  expect(() => signedRefundEvent({ rawData: Buffer.from("{}") })).toThrow(
    "signature"
  )
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "")
  expect(() => signedRefundEvent(signed(body()))).toThrow("signature")
})
it.each([
  {},
  { payload: {} },
  { payload: { refund: {} } },
  {
    payload: { refund: { entity: { id: "rfnd_fixture", payment_id: "bad" } } },
  },
])("rejects malformed refund identities %j", (value) =>
  expect(() =>
    signedRefundEvent(signed({ event: "refund.created", ...value }))
  ).toThrow("identity")
)
it("returns authenticated reconciliation under the shared financial guard", async () => {
  expect(await observeRazorpayRefund(scope, event)).toBe(report)
  expect(sessions).toHaveBeenCalledWith(
    { id: "payses_fixture" },
    { relations: ["payment"], take: 1, options: { refresh: true } }
  )
  expect(mocks.reconcile).toHaveBeenCalledWith("pay_native")
})
it.each([
  { id: "pay_other", order_id: "order_gateway" },
  { id: "pay_gateway", order_id: "bad" },
])("rejects gateway payment binding %j", (value) => {
  mocks.get.mockResolvedValue(value)
  return expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
    "payment identity"
  )
})
it("rejects a swapped order detail", () => {
  mocks.get
    .mockResolvedValueOnce({ id: "pay_gateway", order_id: "order_gateway" })
    .mockResolvedValueOnce({ id: "order_other" })
  return expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
    "order identity"
  )
})
it.each([{}, { notes: {} }, { notes: { medusa_payment_session_id: "bad" } }])(
  "ignores unassociated orders %j",
  (value) => {
    mocks.get
      .mockResolvedValueOnce({ id: "pay_gateway", order_id: "order_gateway" })
      .mockResolvedValueOnce({ id: "order_gateway", ...value })
    return expect(observeRazorpayRefund(scope, event)).resolves.toEqual({
      ignored: "Unassociated gateway order",
    })
  }
)
it.each([{ value: [] }, { value: [{}] }, { value: [{ payment: {} }] }])(
  "ignores missing native payments %j",
  ({ value }) => {
    sessions.mockResolvedValue(value)
    return expect(observeRazorpayRefund(scope, event)).resolves.toEqual({
      ignored: "No native payment association",
    })
  }
)
it.each(["payment", "refund"])(
  "does not accept an unrelated report %s",
  (kind) => {
    if (kind === "payment") report.gateway_payment_id = "pay_other"
    else report.gateway_refunds = []
    return expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
      "not yet reconciled"
    )
  }
)
it("retains external or failed refund discrepancies for financial review without repair", () => {
  report.discrepancies = ["Native refund total differs"]
  return expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
    "requires manual financial review: pay_native"
  )
})
it("propagates unavailable gateway reads for retry", () => {
  mocks.get.mockRejectedValue(Error("unavailable"))
  return expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
    "unavailable"
  )
})

it.each([
  { refund_id: "../bad", payment_id: "pay_gateway" },
  { refund_id: "rfnd_fixture", payment_id: "../bad" },
])("rejects invalid direct observation identity %j", async (value) => {
  await expect(observeRazorpayRefund(scope, value)).rejects.toThrow(
    "observation identity"
  )
  expect(mocks.get).not.toHaveBeenCalled()
})

it("rejects an unconfigured whitespace-only refund webhook secret", () => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "   ")
  expect(() => signedRefundEvent(signed(body()))).toThrow("signature")
})

it.each(["captured", "refunded"])(
  "retains an owned %s refund event while native payment creation is racing",
  async (status) => {
    sessions.mockResolvedValue([{ id: "payses_fixture" }])
    mocks.get
      .mockResolvedValueOnce({
        id: "pay_gateway",
        order_id: "order_gateway",
        status,
        captured: true,
      })
      .mockResolvedValueOnce({
        id: "order_gateway",
        notes: { medusa_payment_session_id: "payses_fixture" },
      })
    await expect(observeRazorpayRefund(scope, event)).rejects.toThrow(
      "not yet available"
    )
    expect(mocks.reconcile).not.toHaveBeenCalled()
  }
)
it("ignores uncaptured auto-refunds without inventing a native payment", async () => {
  sessions.mockResolvedValue([{ id: "payses_fixture" }])
  mocks.get
    .mockResolvedValueOnce({
      id: "pay_gateway",
      order_id: "order_gateway",
      status: "refunded",
      captured: false,
    })
    .mockResolvedValueOnce({
      id: "order_gateway",
      notes: { medusa_payment_session_id: "payses_fixture" },
    })
  await expect(observeRazorpayRefund(scope, event)).resolves.toEqual({
    ignored: "No native payment association",
  })
  expect(mocks.reconcile).not.toHaveBeenCalled()
})
