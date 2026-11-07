import type { MedusaContainer } from "@medusajs/framework/types"
import { importRazorpayRefund, type RefundImportOptions } from "./refund-import"
import { PendingRefundRecoveryError } from "./refund-recovery-error"
import { OperatorRefundRecoveryRequiredError } from "./operator-recovery-required-error"
// Retained so existing subscribers can consume old queued recovery jobs safely.
export const RAZORPAY_REFUND_RECOVERY_EVENT = "razorpay.refund.reconcile"
export const REFUND_RECOVERY_DELAY_MS = 16 * 60 * 1000
export type RefundRecoveryEvent = {
  refund_id: string
  payment_id: string
  provider_id: string
  attempt: number
}
/** No automatic takeover scheduling. Known incomplete accounting requires an operator. */
export async function reconcileRazorpayRefund(
  scope: MedusaContainer,
  event: { refund_id: string; payment_id: string },
  options: RefundImportOptions & { recovery_attempt?: number }
) {
  const attempt = options.recovery_attempt ?? 0
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 3)
    throw new Error("Invalid refund recovery attempt")
  try {
    return await importRazorpayRefund(scope, event, options)
  } catch (error) {
    if (
      error instanceof PendingRefundRecoveryError ||
      error instanceof OperatorRefundRecoveryRequiredError
    )
      return {
        status: "operator_review_required",
        gateway_refund_id: event.refund_id,
      }
    throw error
  }
}
