import { expect, it, vi, beforeEach } from "vitest"
const mocks = vi.hoisted(() => ({ importer: vi.fn(), emit: vi.fn() }))
vi.mock("../src/refund-import", () => ({
  importRazorpayRefund: mocks.importer,
}))
import {
  reconcileRazorpayRefund,
  REFUND_RECOVERY_DELAY_MS,
  RAZORPAY_REFUND_RECOVERY_EVENT,
} from "../src/refund-recovery"
import { PendingRefundRecoveryError } from "../src/refund-recovery-error"
const scope = { resolve: () => ({ emit: mocks.emit }) } as any
const event = { payment_id: "pay_fixture", refund_id: "rfnd_fixture" },
  options = {
    mode: "test" as const,
    key_id: "rzp_test_fixture",
    key_secret: "fixture",
    coordinate: async (_: string[], work: any) => work(),
  }
beforeEach(() => {
  mocks.importer.mockReset()
  mocks.emit.mockReset().mockResolvedValue(undefined)
})
it("returns a completed import without scheduling", async () => {
  mocks.importer.mockResolvedValue({ status: "imported" })
  expect(await reconcileRazorpayRefund(scope, event, options)).toEqual({
    status: "imported",
  })
  expect(mocks.emit).not.toHaveBeenCalled()
})
it("durably schedules a bounded same-operation recovery beyond native grace", async () => {
  mocks.importer.mockRejectedValue(new PendingRefundRecoveryError())
  expect((await reconcileRazorpayRefund(scope, event, options)).status).toBe(
    "deferred"
  )
  expect(REFUND_RECOVERY_DELAY_MS).toBeGreaterThan(15 * 60 * 1000)
  expect(mocks.emit).toHaveBeenCalledWith({
    name: RAZORPAY_REFUND_RECOVERY_EVENT,
    data: { ...event, provider_id: "pp_razorpay_razorpay", attempt: 1 },
    options: expect.objectContaining({
      delay: REFUND_RECOVERY_DELAY_MS,
      jobId: "razorpay-refund-recovery-rfnd_fixture-1",
    }),
  })
  await reconcileRazorpayRefund(scope, event, options)
  expect(mocks.emit.mock.calls[0][0].options.jobId).toBe(
    mocks.emit.mock.calls[1][0].options.jobId
  )
})
it("preserves a custom provider and increments retry attempts", async () => {
  mocks.importer.mockRejectedValue(new PendingRefundRecoveryError())
  await reconcileRazorpayRefund(scope, event, {
    ...options,
    provider_id: "pp_razorpay_custom",
    recovery_attempt: 2,
  })
  expect(mocks.emit.mock.calls[0][0].data).toMatchObject({
    provider_id: "pp_razorpay_custom",
    attempt: 3,
  })
})
it("does not acknowledge when durable enqueue fails", async () => {
  mocks.importer.mockRejectedValue(new PendingRefundRecoveryError())
  mocks.emit.mockRejectedValue(Error("Redis unavailable"))
  await expect(reconcileRazorpayRefund(scope, event, options)).rejects.toThrow(
    "Redis unavailable"
  )
})
it("retains an exhausted reservation for review rather than starting another monetary operation", async () => {
  mocks.importer.mockRejectedValue(new PendingRefundRecoveryError())
  await expect(
    reconcileRazorpayRefund(scope, event, { ...options, recovery_attempt: 3 })
  ).rejects.toThrow("exhausted")
  expect(mocks.emit).not.toHaveBeenCalled()
})
it.each([-1, 4, 1.5, NaN])(
  "rejects invalid attempt %s",
  async (recovery_attempt) => {
    await expect(
      reconcileRazorpayRefund(scope, event, { ...options, recovery_attempt })
    ).rejects.toThrow("Invalid")
    expect(mocks.importer).not.toHaveBeenCalled()
  }
)
it("propagates unrelated financial inconsistencies without automatic retry", async () => {
  mocks.importer.mockRejectedValue(Error("binding mismatch"))
  await expect(reconcileRazorpayRefund(scope, event, options)).rejects.toThrow(
    "binding mismatch"
  )
  expect(mocks.emit).not.toHaveBeenCalled()
})
