import { inrMinorUnits } from "./amounts"
import { createHmac, timingSafeEqual } from "node:crypto"

export function verify(
  body: string | Buffer,
  signature: unknown,
  secret: string
) {
  if (typeof secret !== "string" || !secret.trim())
    throw new Error("Razorpay signature secret is not configured")
  if (
    typeof signature !== "string" ||
    signature.length !== 64 ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    throw new Error("Invalid Razorpay signature")
  const expected = createHmac("sha256", secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new Error("Invalid Razorpay signature")
}

// INR only in both account modes. Reject unsupported precision instead of rounding.
export function minor(amount: unknown, currency: string): number {
  if (currency.toUpperCase() !== "INR") throw new Error("Unsupported currency")
  const result = inrMinorUnits(amount)
  if (result <= 0) throw new Error("Invalid INR amount")
  return result
}

export function verifyRazorpayCheckout(
  orderId: string,
  paymentId: string,
  signature: unknown,
  secret: string
) {
  if (
    !/^order_[A-Za-z0-9]+$/.test(orderId) ||
    !/^pay_[A-Za-z0-9]+$/.test(paymentId) ||
    !secret
  )
    throw new Error("Invalid checkout confirmation identity or configuration")
  verify(orderId + "|" + paymentId, signature, secret)
}
