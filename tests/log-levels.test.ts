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
  ).request("future/opaque", undefined, undefined)
  expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({
    operation: "http_request",
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
      undefined
    )
  ).rejects.toThrow()
  expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({
    operation: "http_request",
    provider_code: "NEW_UPSTREAM_ERROR",
  })
  expect(JSON.stringify(sink.mock.calls)).not.toContain("private")
})

it("preserves injected Medusa debug and error sinks", async () => {
  const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 401 }))
  )
  const provider = new RazorpayProvider(
    { logger: sink },
    {
      mode: "test",
      key_id: "rzp_test_fixture",
      key_secret: "fixture",
      log_level: "debug",
    }
  )
  await expect(
    provider.initiatePayment({
      amount: 1,
      currency_code: "inr",
      context: { idempotency_key: "payses_fixture" },
    })
  ).rejects.toThrow()
  expect(sink.debug).toHaveBeenCalled()
  expect(sink.error).toHaveBeenCalled()
  expect(JSON.parse(sink.error.mock.calls[0][0])).toMatchObject({
    level: "critical",
    operation: "http_request",
    method: "POST",
    http_status: 401,
  })
})

it("logs safe request and response projections only at debug", async () => {
  for (const level of ["debug", "info", "none"] as const) {
    const sink = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "BAD_REQUEST_ERROR",
              description: "invalid request sent",
              source: "NA",
              step: "NA",
              reason: "NA",
              field: "private@example.com",
              metadata: { email: "private@example.com", secret: "secret" },
            },
            email: "private@example.com",
          }),
          { status: 400, headers: { "x-request-id": "sensitive_id" } }
        )
      )
    )
    const gateway = new RazorpayGateway(
      "rzp_test_private",
      "secret",
      { debug: sink, info: sink, warn: sink, error: sink },
      level
    )
    await expect(
      gateway.request(
        "payments/pay_private/refund",
        {
          amount: 2889500,
          speed: "normal",
          notes: {
            medusa_payment_session_id: "payses_private",
            medusa_refund_key: "secret",
            email: "private@example.com",
          },
        },
        { "X-Refund-Idempotency": "private_key" }
      )
    ).rejects.toThrow()
    const logs = sink.mock.calls.map((c) => JSON.parse(c[0]))
    if (level === "debug") {
      expect(
        logs.find((x) => x.outcome === "request_projection")
      ).toMatchObject({
        body_amount_paise: 2889500,
        body_speed: "normal",
        body_notes_count: 3,
        body_idempotency_present: true,
        body_idempotency_length: 11,
        body_session_note_present: true,
      })
      expect(
        logs.find((x) => x.outcome === "response_projection")
      ).toMatchObject({
        http_status: 400,
        provider_code: "BAD_REQUEST_ERROR",
        category: "invalid_request",
        provider_source: "NA",
        provider_step: "NA",
        provider_reason: "NA",
        provider_metadata_count: 2,
        response_request_id_present: true,
      })
    } else
      expect(logs.some((x) => x.outcome.endsWith("projection"))).toBe(false)
    if (level === "none") expect(sink).not.toHaveBeenCalled()
    expect(JSON.stringify(logs)).not.toMatch(
      /private|secret|sensitive_id|payses_|pay_private|invalid request sent/
    )
  }
})
it("drops unsafe response classifications and never echoes a successful refund identity", async () => {
  const sink = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "rfnd_private",
          status: "processed",
          amount: 100,
          currency: "INR",
          speed_processed: "normal",
          email: "private@example.com",
          error: {
            source: "private@example.com",
            reason: "secret",
            step: "https://private",
          },
        })
      )
    )
  )
  await new RazorpayGateway(
    "key",
    "secret",
    { debug: sink, info: sink },
    "debug"
  ).request("opaque", {}, undefined)
  const logs = sink.mock.calls.map((c) => JSON.parse(c[0]))
  expect(logs.find((x) => x.outcome === "response_projection")).toMatchObject({
    response_amount_paise: 100,
    response_currency: "INR",
    response_refund_status: "processed",
    response_speed: "normal",
    response_identity_present: true,
  })
  expect(JSON.stringify(logs)).not.toMatch(/private|secret|https/)
})
