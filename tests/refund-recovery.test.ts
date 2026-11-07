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
import { OperatorRefundRecoveryRequiredError } from "../src/operator-recovery-required-error"
const scope = { resolve: () => ({ emit: mocks.emit }) } as any
const event = { payment_id: "pay_fixture", refund_id: "rfnd_fixture" }
const options = {
  mode: "test" as const,
  key_id: "rzp_test_fixture",
  key_secret: "fixture",
  coordinate: async <T>(_ids: string[], work: () => Promise<T>) => work(),
}
beforeEach(() => {
  mocks.importer.mockReset()
  mocks.emit.mockReset()
})
it("returns a completed import without scheduling", async () => {
  mocks.importer.mockResolvedValue({ status: "imported" })
  expect(await reconcileRazorpayRefund(scope, event, options)).toEqual({
    status: "imported",
  })
  expect(mocks.emit).not.toHaveBeenCalled()
})
it.each([
  new PendingRefundRecoveryError(),
  new OperatorRefundRecoveryRequiredError(),
])(
  "routes incomplete accounting to operator review without scheduling %s",
  async (error) => {
    mocks.importer.mockRejectedValue(error)
    expect((await reconcileRazorpayRefund(scope, event, options)).status).toBe(
      "operator_review_required"
    )
    expect(mocks.emit).not.toHaveBeenCalled()
  }
)
it("consumes old delayed events without starting another takeover chain", async () => {
  mocks.importer.mockRejectedValue(new OperatorRefundRecoveryRequiredError())
  expect(
    (
      await reconcileRazorpayRefund(scope, event, {
        ...options,
        recovery_attempt: 3,
      })
    ).status
  ).toBe("operator_review_required")
  expect(mocks.emit).not.toHaveBeenCalled()
  expect(REFUND_RECOVERY_DELAY_MS).toBe(16 * 60 * 1000)
  expect(RAZORPAY_REFUND_RECOVERY_EVENT).toBe("razorpay.refund.reconcile")
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
it("propagates unrelated financial inconsistencies", async () => {
  mocks.importer.mockRejectedValue(new Error("binding mismatch"))
  await expect(reconcileRazorpayRefund(scope, event, options)).rejects.toThrow(
    "binding mismatch"
  )
  expect(mocks.emit).not.toHaveBeenCalled()
})
