import { BigNumber } from "@medusajs/framework/utils"
import type { BigNumberInput } from "@medusajs/framework/types"

/** Exact INR accounting conversion; positivity is a caller-specific constraint. */
export function inrMinorUnits(
  value: unknown,
  { allowNegative = false }: { allowNegative?: boolean } = {}
): number {
  if (value === undefined || value === null)
    throw new Error("Invalid INR amount")
  const decimal = new BigNumber(value as BigNumberInput).bigNumber
  if (!decimal || !decimal.isFinite()) throw new Error("Invalid INR amount")
  const minor = decimal.multipliedBy(100)
  if (!minor.isInteger() || (!allowNegative && minor.lt(0)))
    throw new Error("Invalid INR amount")
  if (minor.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error("INR amount exceeds supported range")
  return minor.toNumber()
}

/** Use a decimal string at Medusa BigNumberValue boundaries, never float division. */
export function inrMajorUnits(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid INR minor amount")
  const negative = value < 0
  const amount = BigInt(Math.abs(value))
  return (
    (negative ? "-" : "") +
    amount / 100n +
    "." +
    String(amount % 100n).padStart(2, "0")
  )
}
