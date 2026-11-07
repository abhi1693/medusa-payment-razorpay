import { afterEach, it, expect, vi } from "vitest"
import { RazorpayGateway, GatewayRequestError } from "../src/gateway"
import { gatewayReader } from "../src/reconciliation"
afterEach(() => vi.unstubAllGlobals())
it.each(["get", "post", "put", "patch", "delete"] as const)(
  "centralizes %s execution and automatic diagnostics",
  async (verb) => {
    const sink = vi.fn(),
      fetcher = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetcher)
    const client = new RazorpayGateway(
      "key",
      "secret",
      { debug: sink, info: sink, warn: sink, error: sink },
      "debug"
    )
    if (verb === "get" || verb === "delete")
      await client[verb]("resource/opaque")
    else
      await client[verb]("resource/opaque", {
        amount: 100,
        notes: { email: "private@example.com" },
      })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: verb.toUpperCase(),
      redirect: "error",
    })
    const logs = sink.mock.calls.map((c) => JSON.parse(c[0]))
    expect(logs[0]).not.toHaveProperty("operation")
    expect(logs[0]).toMatchObject({
      event: "razorpay.gateway",
      method: verb.toUpperCase(),
      outcome: "started",
    })
    expect(logs.some((x) => x.outcome === "response_projection")).toBe(true)
    expect(JSON.stringify(logs)).not.toMatch(/private|secret|opaque/)
  }
)
it("reconciliation uses the same client and exposes no write verb", async () => {
  const sink = vi.fn(),
    fetcher = vi.fn().mockResolvedValue(new Response("{}"))
  vi.stubGlobal("fetch", fetcher)
  const get = gatewayReader({
    mode: "test",
    key_id: "rzp_test_fixture",
    key_secret: "fixture",
    log_level: "debug",
    logger: { debug: sink, info: sink, warn: sink, error: sink },
  })
  await get("payments/pay_private")
  expect(typeof get).toBe("function")
  expect((get as any).post).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].method).toBe("GET")
  expect(
    sink.mock.calls
      .map((c) => JSON.parse(c[0]))
      .some((x) => x.outcome === "response_projection")
  ).toBe(true)
})
it("read HTTP errors do not claim uncertain monetary mutation", async () => {
  const sink = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 400 }))
  )
  await expect(
    new RazorpayGateway("key", "secret", { warn: sink }).get(
      "payments/pay_private"
    )
  ).rejects.toMatchObject({ method: "GET", outcome: "http_error", status: 400 })
  expect(JSON.parse(sink.mock.calls[0][0]).reconciliation_required).toBe(false)
})
it("does not retry failed writes and retains stable idempotency", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }))
  vi.stubGlobal("fetch", fetcher)
  const client = new RazorpayGateway("key", "secret", {}, "none")
  await expect(
    client.post(
      "payments/pay_private/refund",
      { amount: 100 },
      { "X-Refund-Idempotency": "stable_test_key" }
    )
  ).rejects.toBeInstanceOf(GatewayRequestError)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].headers["X-Refund-Idempotency"]).toBe(
    "stable_test_key"
  )
})
it("accepts an empty successful DELETE response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  )
  await expect(
    new RazorpayGateway("key", "secret", {}, "none").delete("resource/opaque")
  ).resolves.toBeUndefined()
})
