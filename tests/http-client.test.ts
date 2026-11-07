import { it, expect, vi, afterEach } from "vitest"
import {
  RazorpayGateway,
  GatewayRequestError,
  type GatewayOptions,
} from "../src/gateway"
import { gatewayReader } from "../src/reconciliation"
import RazorpayProvider from "../src/service"
afterEach(() => vi.unstubAllGlobals())
const options: GatewayOptions = {
  key_id: "rzp_test_fixture",
  key_secret: "fixture_secret",
}
it.each(["get", "post", "put", "patch", "delete"] as const)(
  "centralizes %s transport and logging",
  async (verb) => {
    const sink = vi.fn(),
      fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}")),
      client = new RazorpayGateway({
        ...options,
        fetch: fetcher,
        logger: { debug: sink, info: sink, warn: sink, error: sink },
        log_level: "debug",
      })
    if (verb === "get" || verb === "delete")
      await client[verb]("resource/fixture")
    else await client[verb]("resource/fixture", { amount: 100 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: verb.toUpperCase(),
      redirect: "error",
    })
    const logs = sink.mock.calls.map((call) => JSON.parse(call[0]))
    expect(logs[0]).toMatchObject({
      level: "debug",
      message: "Sending Razorpay API request",
      context: { method: verb.toUpperCase(), path: "resource/fixture" },
    })
    expect(
      logs.some((record) => record.message === "Received Razorpay API response")
    ).toBe(true)
  }
)
it("retains native idempotency without retry or authentication override", async () => {
  const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 400 })),
    client = new RazorpayGateway({
      ...options,
      fetch: fetcher,
      log_level: "none",
    })
  await expect(
    client.post(
      "payments/pay_fixture/refund",
      { amount: 100 },
      { "X-Refund-Idempotency": "stable_key", Authorization: "invalid" }
    )
  ).rejects.toMatchObject({ kind: "http", status: 400, method: "POST" })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
  expect(headers.get("X-Refund-Idempotency")).toBe("stable_key")
  expect(headers.get("Authorization")).not.toBe("invalid")
})
it("reconciliation shares the client through GET only", async () => {
  const sink = vi.fn(),
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
  vi.stubGlobal("fetch", fetcher)
  const get = gatewayReader({
    mode: "test",
    key_id: options.key_id,
    key_secret: options.key_secret,
    logger: { debug: sink },
    log_level: "debug",
  })
  await get("payments/pay_fixture")
  expect(fetcher.mock.calls[0][1]?.method).toBe("GET")
  expect(Object.keys(get)).not.toContain("post")
  expect(
    sink.mock.calls.some(
      (call) => JSON.parse(call[0]).message === "Received Razorpay API response"
    )
  ).toBe(true)
})
it("does not report a failed GET as an uncertain monetary write", async () => {
  const sink = vi.fn(),
    client = new RazorpayGateway({
      ...options,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 400 })),
      logger: { warn: sink },
    })
  await expect(client.get("orders")).rejects.toBeInstanceOf(GatewayRequestError)
  expect(
    JSON.parse(sink.mock.calls[0][0]).context.reconciliation_required
  ).toBe(false)
})
it("uses generic transport failures without error details or code enumeration", async () => {
  const sink = vi.fn(),
    client = new RazorpayGateway({
      ...options,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(
        Object.assign(new Error("private@example.com"), {
          cause: { code: "NEW_NETWORK_CODE" },
        })
      ),
      logger: { error: sink },
    })
  await expect(
    client.post("payments/pay_fixture/refund", {})
  ).rejects.toMatchObject({ kind: "transport" })
  const output = sink.mock.calls[0][0]
  expect(output).toContain("Razorpay transport failed")
  expect(output).not.toMatch(/NEW_NETWORK_CODE|private@example.com/)
})
it("keeps complete JSON responses visible at debug without field selection", async () => {
  const sink = vi.fn(),
    payload = {
      error: {
        code: "BAD_REQUEST_ERROR",
        description: "invalid request sent",
        source: "NA",
        step: "NA",
        reason: "NA",
        metadata: { new_field: "visible", email: "person@example.com" },
      },
    },
    client = new RazorpayGateway({
      ...options,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify(payload), { status: 400 })
        ),
      logger: { debug: sink, warn: sink },
      log_level: "debug",
    })
  await expect(
    client.post("payments/pay_fixture/refund", {
      amount: 2889500,
      speed: "normal",
      notes: { email: "person@example.com" },
    })
  ).rejects.toThrow("reconcile")
  const logs = sink.mock.calls.map((call) => JSON.parse(call[0]))
  expect(
    logs.find((record) => record.message === "Sending Razorpay API request")
      .context.request
  ).toMatchObject({
    amount: 2889500,
    speed: "normal",
    notes: { email: "person@example.com" },
  })
  expect(
    logs.find((record) => record.message === "Received Razorpay API response")
      .context.response.error
  ).toMatchObject({
    code: "BAD_REQUEST_ERROR",
    description: "invalid request sent",
    source: "NA",
    step: "NA",
    reason: "NA",
    metadata: { new_field: "visible", email: "person@example.com" },
  })
  expect(JSON.stringify(logs)).toContain("person@example.com")
})
it("logs raw non-JSON responses and preserves HTTP failure classification", async () => {
  const sink = vi.fn(),
    client = new RazorpayGateway({
      ...options,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("upstream error person@example.com", { status: 502 })
        ),
      logger: { debug: sink, error: sink },
      log_level: "debug",
    })
  await expect(client.get("orders")).rejects.toMatchObject({
    kind: "http",
    status: 502,
  })
  expect(JSON.stringify(sink.mock.calls)).toContain("upstream error")
  expect(JSON.stringify(sink.mock.calls)).toContain("person@example.com")
})
it("distinguishes malformed successful JSON", async () => {
  const client = new RazorpayGateway({
    ...options,
    fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON")),
    log_level: "none",
  })
  await expect(client.get("orders")).rejects.toMatchObject({
    kind: "response",
    status: 200,
  })
})
it("supports empty successful responses", async () => {
  await expect(
    new RazorpayGateway({
      ...options,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 })),
      log_level: "none",
    }).delete("resource/fixture")
  ).resolves.toBeUndefined()
})
it("none suppresses client and provider lifecycle logging", async () => {
  const sink = vi.fn(),
    logger = { debug: sink, info: sink, warn: sink, error: sink },
    client = new RazorpayGateway({
      ...options,
      logger,
      log_level: "none",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 400 })),
    })
  await expect(client.post("payments/pay_fixture/refund", {})).rejects.toThrow()
  await expect(
    new RazorpayProvider(
      { logger },
      { ...options, mode: "test", log_level: "none" }
    ).refundPayment({ data: {}, amount: 1 })
  ).rejects.toThrow()
  expect(sink).not.toHaveBeenCalled()
})
it("validates construction and prevents alternate-host paths", async () => {
  expect(() => new RazorpayGateway({ ...options, timeout_ms: 0 })).toThrow()
  expect(() => new RazorpayGateway({ ...options, key_secret: "" })).toThrow()
  const fetcher = vi.fn<typeof fetch>(),
    client = new RazorpayGateway({
      ...options,
      fetch: fetcher,
      log_level: "none",
    })
  await expect(client.get("https://other.invalid/orders")).rejects.toThrow(
    "relative"
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it("does not intentionally include authentication headers or configured API credentials in log context", async () => {
  const sink = vi.fn(),
    client = new RazorpayGateway({
      ...options,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}")),
      logger: { debug: sink, info: sink },
      log_level: "debug",
    })
  await client.get("orders")
  const output = JSON.stringify(sink.mock.calls)
  expect(output).not.toMatch(/Authorization|fixture_secret|rzp_test_fixture/)
})
