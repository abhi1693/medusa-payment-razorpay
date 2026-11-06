import { BigNumber } from "@medusajs/framework/utils"
import type { BigNumberInput } from "@medusajs/framework/types"
import { createHmac, timingSafeEqual } from "node:crypto"

export function verify(
  body: string | Buffer,
  signature: unknown,
  secret: string
) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature))
    throw new Error("Invalid Razorpay signature")
  const expected = createHmac("sha256", secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new Error("Invalid Razorpay signature")
}

// INR only in this test-stage release. Reject unsupported precision instead of rounding.
export function minor(amount: unknown, currency: string): number {
  if (currency.toUpperCase() !== "INR") throw new Error("Unsupported currency")
  const value =
    new BigNumber(amount as BigNumberInput).bigNumber?.toFixed() ?? ""
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("Invalid INR amount")
  const [major, fraction = ""] = value.split(".")
  const result = BigInt(major) * 100n + BigInt(fraction.padEnd(2, "0"))
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid INR amount")
  return Number(result)
}
