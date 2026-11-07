import { MedusaError } from "@medusajs/framework/utils"

/** A rejected refund POST, not evidence of a particular balance problem. */
export class RazorpayRefundRejectedError extends MedusaError {
  constructor(cause: Error) {
    super(
      MedusaError.Types.INVALID_DATA,
      "Razorpay rejected the refund; verify its status and your available balance before retrying.",
      "razorpay_refund_rejected"
    )
    this.cause = cause
  }
}
