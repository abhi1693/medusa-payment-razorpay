import { MedusaError } from "@medusajs/framework/utils"
// Existing gateway funds must be adopted by the coordinated native importer,
// never by restoring a second native attempt after canonical import.
export class GatewayRefundReconciliationError extends MedusaError {
  constructor(readonly gateway_refund_id: string) {
    super(
      MedusaError.Types.CONFLICT,
      "Razorpay refund " +
        gateway_refund_id +
        " is already processed. Await signed reconciliation; do not issue another refund."
    )
    this.name = "GatewayRefundReconciliationError"
  }
}
