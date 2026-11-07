import { MedusaError } from "@medusajs/framework/utils"
// A gateway request exists, but native financial accounting must await processing.
export class GatewayRefundPendingError extends MedusaError {
  constructor(readonly gateway_refund_id: string) {
    super(
      MedusaError.Types.CONFLICT,
      "Razorpay refund " +
        gateway_refund_id +
        " is pending. Do not issue another refund; signed reconciliation will record it after processing."
    )
    this.name = "GatewayRefundPendingError"
  }
}
