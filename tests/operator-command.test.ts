import { expect, it } from "vitest"
import { parseRefundRecoveryCommand } from "../src/scripts/refund-recovery"
const target = ["./recovery-config.ts", "pay_native", "rfnd_gateway"]
it("parses a read-only assessment without credentials in arguments", () => {
  expect(parseRefundRecoveryCommand(["assess", ...target])).toMatchObject({
    action: "assess",
    config: "./recovery-config.ts",
    native_payment_id: "pay_native",
    gateway_refund_id: "rfnd_gateway",
  })
})
it("requires a reviewed fingerprint for apply", () => {
  expect(() => parseRefundRecoveryCommand(["apply", ...target])).toThrow()
  expect(
    parseRefundRecoveryCommand(["apply", ...target, "a".repeat(64)]).action
  ).toBe("apply")
})
it.each([
  ["refund", ...target],
  ["assess", ...target, "--secret", "value"],
  ["assess", ...target, "--config", "duplicate.ts"],
  ["assess", ...target, "a".repeat(64)],
  ["apply", ...target, "invalid"],
  ["assess", "--config"],
])("rejects unsupported or ambiguous command %j", (...args) => {
  expect(() => parseRefundRecoveryCommand(args)).toThrow()
})
