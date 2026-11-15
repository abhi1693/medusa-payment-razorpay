import { expect, it } from "vitest"
import { BigNumber } from "@medusajs/framework/utils"
import { inrMinorUnits, inrMajorUnits } from "../src/amounts"

it.each([
  "123.45",
  123.45,
  new BigNumber("123.45"),
  { value: "123.45", precision: 20 },
])("converts native major-unit values exactly: %j", (value) => {
  expect(inrMinorUnits(value)).toBe(12345)
})
it.each([undefined, null, NaN, Infinity, "not-a-number", -1, "-0.001"])(
  "rejects invalid unsigned values: %j",
  (value) => {
    expect(() => inrMinorUnits(value)).toThrow()
  }
)
it.each(["0", "0.00", 0])("retains zero for accounting totals: %j", (value) => {
  expect(inrMinorUnits(value)).toBe(0)
})
it("keeps signed native order transactions exact", () => {
  expect(inrMinorUnits("-212.98", { allowNegative: true })).toBe(-21298)
  expect(inrMajorUnits(-21298)).toBe("-212.98")
})
it.each([1, 99, 100, 12345, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])(
  "round-trips every paise at %s without float division",
  (amount) => {
    expect(inrMinorUnits(inrMajorUnits(amount), { allowNegative: true })).toBe(
      amount
    )
  }
)
it("preserves the maximum supported amount's final paise", () => {
  expect(inrMajorUnits(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91")
  expect(inrMinorUnits("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER)
  expect(() => inrMinorUnits("90071992547409.92")).toThrow("supported range")
})
it.each([NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])(
  "rejects unsafe minor-unit formatting: %j",
  (amount) => {
    expect(() => inrMajorUnits(amount)).toThrow()
  }
)

it.each([
  ["5762.117", 576212],
  ["1.004", 100],
  ["1.005", 101],
  ["1.006", 101],
  ["1.001", 100],
  ["0.004", 0],
  [{ value: "5762.117", precision: 20 }, 576212],
  [new BigNumber("5762.117"), 576212],
])("rounds native totals to paise: %j", (value, expected) => {
  expect(inrMinorUnits(value)).toBe(expected)
})
it("rounds signed accounting totals symmetrically", () => {
  expect(inrMinorUnits("-1.005", { allowNegative: true })).toBe(-101)
})
