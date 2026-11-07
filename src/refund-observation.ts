import type {
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { verify } from "./security"
import { record } from "./records"
import type { RazorpayReconciliationReport } from "./reconciliation"
export type RefundObservationDependencies = {
  get: (path: string) => Promise<Record<string, unknown>>
  reconcile: (nativePaymentId: string) => Promise<RazorpayReconciliationReport>
  coordinate: <T>(sessionIds: string[], work: () => Promise<T>) => Promise<T>
}
// JSON queues serialize Buffer bytes. Reconstruct bytes, never parsed-body JSON.
export function signedRefundEvent(
  payload: {
    rawData?: unknown
    headers?: Record<string, unknown>
  },
  secret: string | undefined
) {
  let raw = payload.rawData
  if (!Buffer.isBuffer(raw)) {
    const value = record(raw)
    if (
      value.type !== "Buffer" ||
      !Array.isArray(value.data) ||
      !value.data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    )
      throw new Error("Missing raw webhook bytes")
    raw = Buffer.from(value.data)
  }
  try {
    verify(
      raw as Buffer,
      payload.headers?.["x-razorpay-signature"],
      secret as string
    )
  } catch {
    throw new Error("Invalid refund webhook signature")
  }
  const event = JSON.parse((raw as Buffer).toString())
  if (
    ![
      "refund.created",
      "refund.processed",
      "refund.failed",
      "refund.speed_changed",
    ].includes(event.event)
  )
    return null
  const refund = record(record(record(event.payload).refund).entity)
  if (
    !/^rfnd_[A-Za-z0-9]+$/.test(String(refund.id)) ||
    !/^pay_[A-Za-z0-9]+$/.test(String(refund.payment_id))
  )
    throw new Error("Invalid refund webhook identity")
  return { refund_id: String(refund.id), payment_id: String(refund.payment_id) }
}

// Observation never issues a monetary request or fabricates a native refund.
export async function observeRazorpayRefund(
  scope: MedusaContainer,
  event: { refund_id: string; payment_id: string },
  dependencies: RefundObservationDependencies
) {
  if (
    !/^rfnd_[A-Za-z0-9]+$/.test(event.refund_id) ||
    !/^pay_[A-Za-z0-9]+$/.test(event.payment_id)
  )
    throw new Error("Invalid refund observation identity")
  const { get, reconcile, coordinate } = dependencies
  const payment = await get("payments/" + event.payment_id)
  if (
    payment.id !== event.payment_id ||
    !/^order_[A-Za-z0-9]+$/.test(String(payment.order_id))
  )
    throw new Error("Refund payment identity mismatch")
  const order = await get("orders/" + payment.order_id)
  const sessionId = record(order.notes).medusa_payment_session_id
  if (order.id !== payment.order_id)
    throw new Error("Refund order identity mismatch")
  if (typeof sessionId !== "string" || !/^payses_[A-Za-z0-9]+$/.test(sessionId))
    return { ignored: "Unassociated gateway order" }
  const service = scope.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const sessions = await service.listPaymentSessions(
    { id: sessionId },
    { relations: ["payment"], take: 1 }
  )
  const native = record(record(sessions[0]).payment)
  // Uncaptured automatic refunds and other applications have no native payment.
  if (!native.id) {
    // A captured refund can arrive before browser/webhook authorization creates
    // the native Payment. Keep that owned event retryable instead of losing it.
    if (
      record(sessions[0]).id === sessionId &&
      payment.captured !== false &&
      ["captured", "refunded"].includes(String(payment.status))
    )
      throw new Error(
        "Native Razorpay payment association is not yet available: " + sessionId
      )
    return { ignored: "No native payment association" }
  }
  return coordinate([sessionId], async () => {
    const report = await reconcile(String(native.id))
    if (
      report.gateway_payment_id !== event.payment_id ||
      !report.gateway_refunds.some((r) => r.id === event.refund_id)
    )
      throw new Error("Refund association not yet reconciled")
    if (report.discrepancies.length)
      throw new Error(
        `Razorpay refund requires manual financial review: ${report.payment_id}; ${report.discrepancies.join("; ")}`
      )
    return report
  })
}
