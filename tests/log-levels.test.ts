import RazorpayProvider from "../src/service"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  defineLogEvent,
  gatewayLogEvent,
  lifecycleLogEvent,
  logFields,
  diagnostics,
  LOG_LEVELS,
  validateLogLevel,
} from "../src/diagnostics"
import { RazorpayGateway } from "../src/gateway"
afterEach(() => vi.unstubAllGlobals())
describe("logging threshold and field allowlists", () => {
  it("emits each severity only at or above its threshold, with none silent", () => {
    for (let threshold = 0; threshold < LOG_LEVELS.length; threshold++) {
      const sink = vi.fn(),
        log = diagnostics(
          { debug: sink, info: sink, warn: sink, error: sink },
          LOG_LEVELS[threshold]
        )
      for (const level of LOG_LEVELS.slice(0, 5))
        log(level as Exclude<typeof level, "none">, lifecycleLogEvent, {
          operation: "refundPayment",
          outcome: "completed",
          email: "private@example.com",
          secret: "secret",
        })
      expect(sink).toHaveBeenCalledTimes(threshold === 5 ? 0 : 5 - threshold)
      expect(JSON.stringify(sink.mock.calls)).not.toMatch(/private|secret/)
    }
  })
  it("rejects unsupported configuration", () => {
    expect(validateLogLevel(undefined)).toBe("info")
    expect(() => validateLogLevel("verbose")).toThrow()
    expect(() => validateLogLevel(null)).toThrow()
  })
  it("drops arbitrary values even for known keys", () => {
    const sink = vi.fn()
    diagnostics({ info: sink }, "debug")("info", gatewayLogEvent, {
      operation: "private@example.com",
      provider_code: "SECRET",
      correlation: "pay_private",
      method: "private@example.com",
      http_status: "secret",
      duration_ms: -1,
      reconciliation_required: "secret",
      headers: { authorization: "secret" },
    })
    expect(JSON.parse(sink.mock.calls[0][0])).toEqual({
      event: "razorpay.gateway",
      level: "info",
    })
  })
  it("none keeps both successful and failed gateway calls silent", async () => {
    const sink = vi.fn(),
      gateway = new RazorpayGateway(
        "key",
        "secret",
        { debug: sink, info: sink, warn: sink, error: sink },
        "none"
      )
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}"))
        .mockResolvedValueOnce(new Response("{}", { status: 400 }))
    )
    await gateway.request("payments/pay_private/refund", {})
    await expect(gateway.request("orders")).rejects.toThrow()
    expect(sink).not.toHaveBeenCalled()
  })
})

it("extends event schemas without editing the logger or operation lists", () => {
  const sink = vi.fn(),
    event = defineLogEvent("razorpay.recovery.checkpoint", {
      phase: logFields.label,
      attempt: logFields.number,
    })
  diagnostics({ info: sink })("info", event, {
    phase: "new_recovery_phase",
    attempt: 2,
    email: "person@example.com",
    payload: { secret: "value" },
  })
  expect(JSON.parse(sink.mock.calls[0][0])).toEqual({
    event: "razorpay.recovery.checkpoint",
    level: "info",
    phase: "new_recovery_phase",
    attempt: 2,
  })
})

it("suppresses lifecycle and gateway logs at provider level none", async () => {
  const sink = vi.fn(),
    provider = new RazorpayProvider(
      { logger: { debug: sink, info: sink, warn: sink, error: sink } },
      {
        mode: "test",
        key_id: "rzp_test_fixture",
        key_secret: "fixture",
        log_level: "none",
      }
    )
  await expect(
    provider.refundPayment({ data: {}, amount: 1 })
  ).rejects.toThrow()
  expect(sink).not.toHaveBeenCalled()
})
it("accepts a new operation without URL parsing or a central list", async () => {
  const sink = vi.fn()
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
  await new RazorpayGateway(
    "key",
    "secret",
    { debug: sink, info: sink },
    "debug"
  ).request("future/opaque", undefined, undefined, "future_operation")
  expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({
    operation: "future_operation",
    method: "GET",
    outcome: "started",
  })
})

it("accepts a bounded new provider code without a value list", async () => {
  const sink = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "NEW_UPSTREAM_ERROR",
            description: "private@example.com",
          },
        }),
        { status: 400 }
      )
    )
  )
  await expect(
    new RazorpayGateway("key", "secret", { warn: sink }).request(
      "opaque",
      undefined,
      undefined,
      "new_phase"
    )
  ).rejects.toThrow()
  expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({
    operation: "new_phase",
    provider_code: "NEW_UPSTREAM_ERROR",
  })
  expect(JSON.stringify(sink.mock.calls)).not.toContain("private")
})
