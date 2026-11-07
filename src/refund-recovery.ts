import type {
  MedusaContainer,
  IEventBusModuleService,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { importRazorpayRefund, type RefundImportOptions } from "./refund-import"
import { PendingRefundRecoveryError } from "./refund-recovery-error"
export const RAZORPAY_REFUND_RECOVERY_EVENT = "razorpay.refund.reconcile"
export type RefundRecoveryEvent = {
  refund_id: string
  payment_id: string
  provider_id: string
  attempt: number
}
// Longer than the verified native 15-minute pending-reservation grace period.
export const REFUND_RECOVERY_DELAY_MS = 16 * 60 * 1000
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
    if (!(error instanceof PendingRefundRecoveryError)) throw error
    if (attempt >= 3)
      throw new Error(
        "Native refund reservation recovery exhausted; financial review required"
      )
    const next = attempt + 1
    await scope.resolve<IEventBusModuleService>(Modules.EVENT_BUS).emit({
      name: RAZORPAY_REFUND_RECOVERY_EVENT,
      data: {
        ...event,
        provider_id: options.provider_id || "pp_razorpay_razorpay",
        attempt: next,
      } satisfies RefundRecoveryEvent,
      options: {
        jobId: "razorpay-refund-recovery-" + event.refund_id + "-" + next,
        delay: REFUND_RECOVERY_DELAY_MS,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
      },
    })
    return {
      status: "deferred",
      gateway_refund_id: event.refund_id,
      retry_after_ms: REFUND_RECOVERY_DELAY_MS,
    }
  }
}
