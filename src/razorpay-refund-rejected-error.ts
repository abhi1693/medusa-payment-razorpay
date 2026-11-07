import { MedusaError } from "@medusajs/framework/utils"

/** A rejected refund POST, not evidence of a particular balance problem. */
export class RazorpayRefundRejectedError extends MedusaError {
  constructor(cause: Error) {
    super(
      MedusaError.Types.INVALID_DATA,
      "Razorpay rejected this refund request. Check your Razorpay available balance and the payment’s remaining refundable amount. Confirm the refund status in Razorpay before retrying.",
      "razorpay_refund_rejected"
    )
    this.cause = cause
  }
}
