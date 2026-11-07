import { afterEach, describe, expect, it, vi } from "vitest"
import { RazorpayGateway } from "../src/gateway"
afterEach(() => vi.unstubAllGlobals())
const logger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
})
describe("sanitized gateway diagnostics", () => {
  it("logs safe failure facts without payloads, identifiers, headers or PII", async () => {
    const log = logger(),
      fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "BAD_REQUEST_ERROR",
              description: "invalid request sent",
              metadata: {
                email: "private@example.com",
                payment_id: "pay_private",
                secret: "secret",
              },
            },
            headers: { authorization: "secret" },
          }),
          { status: 400, headers: { "x-request-id": "private_request" } }
        )
      )
    vi.stubGlobal("fetch", fetcher)
    await expect(
      new RazorpayGateway("rzp_test_private", "secret", log).request(
        "payments/pay_private/refund",
        { amount: 100, notes: { email: "private@example.com" } },
        { "X-Refund-Idempotency": "private_key" }
      )
    ).rejects.toThrow("reconcile gateway state")
    const data = JSON.parse(
      [...log.warn.mock.calls, ...log.error.mock.calls][0][0]
    )
    expect(data).toMatchObject({
      event: "razorpay.gateway",
      operation: "request",
      outcome: "http_error",
      http_status: 400,
      provider_code: "BAD_REQUEST_ERROR",
      category: "invalid_request",
      reconciliation_required: true,
    })
    expect(data.correlation).toMatch(/^[a-f0-9-]{36}$/)
    const output = JSON.stringify([
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ])
    for (const value of [
      "private",
      "secret",
      "authorization",
      "notes",
      "headers",
    ])
      expect(output).not.toContain(value)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("does not echo arbitrary provider strings", async () => {
    const log = logger()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "PRIVATE_CUSTOMER_TOKEN",
              description: "private@example.com",
              reason: "secret",
            },
          }),
          { status: 400 }
        )
      )
    )
    await expect(
      new RazorpayGateway("key", "secret", log).request(
        "unexpected/private/path"
      )
    ).rejects.toThrow()
    expect(
      JSON.parse([...log.warn.mock.calls, ...log.error.mock.calls][0][0])
    ).toMatchObject({
      operation: "request",
      category: "unclassified",
    })
    expect(
      JSON.stringify([...log.warn.mock.calls, ...log.error.mock.calls])
    ).not.toMatch(/PRIVATE|private|secret/)
  })
  it("handles non-JSON failures without exposing the body", async () => {
    const log = logger()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private secret", { status: 502 }))
    )
    await expect(
      new RazorpayGateway("key", "secret", log).request("orders/order_private")
    ).rejects.toThrow()
    expect(
      JSON.parse([...log.warn.mock.calls, ...log.error.mock.calls][0][0])
    ).toMatchObject({
      operation: "request",
      http_status: 502,
      provider_code: "UNRECOGNIZED",
    })
  })
  it("logs transport uncertainty without the exception or a retry", async () => {
    const log = logger(),
      fetcher = vi.fn().mockRejectedValue(new Error("secret private url"))
    vi.stubGlobal("fetch", fetcher)
    await expect(
      new RazorpayGateway("key", "secret", log).request(
        "payments/pay_private/refund",
        {}
      )
    ).rejects.toThrow("reconcile gateway state")
    expect(JSON.parse(log.error.mock.calls[0][0])).toMatchObject({
      outcome: "transport_error",
      reconciliation_required: true,
    })
    expect(
      JSON.stringify([...log.warn.mock.calls, ...log.error.mock.calls])
    ).not.toMatch(/secret|private/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("does not let a failing logger change successful refund behavior", async () => {
    const log = {
      info: () => {
        throw Error("logger")
      },
      warn: () => {
        throw Error("logger")
      },
    }
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ id: "rfnd_private" })))
    )
    await expect(
      new RazorpayGateway("key", "secret", log).request(
        "payments/pay_private/refund",
        {}
      )
    ).resolves.toEqual({ id: "rfnd_private" })
  })
  it("logs a successful refund response without interpreting settlement", async () => {
    const log = logger()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ id: "rfnd_private", status: "pending" })
          )
        )
    )
    await new RazorpayGateway("key", "secret", log).request(
      "payments/pay_private/refund",
      {}
    )
    expect(JSON.parse(log.info.mock.calls[0][0])).toMatchObject({
      outcome: "response_received",
      http_status: 200,
    })
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/private|pending/)
  })
  it("logs malformed successful responses as uncertain", async () => {
    const log = logger()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret")))
    await expect(
      new RazorpayGateway("key", "secret", log).request("refunds/rfnd_private")
    ).rejects.toThrow("reconcile gateway state")
    expect(
      JSON.parse([...log.warn.mock.calls, ...log.error.mock.calls][0][0])
    ).toMatchObject({
      operation: "request",
      outcome: "invalid_response",
    })
  })
})

it("classifies DNS and timeout failures without exposing exception details", async () => {
  for (const error of [
    Object.assign(new Error("private"), { cause: { code: "ENOTFOUND" } }),
    Object.assign(new Error("secret"), { name: "TimeoutError" }),
  ]) {
    const log = logger()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error))
    await expect(
      new RazorpayGateway("key", "secret", log).request("orders")
    ).rejects.toThrow("reconcile gateway state")
    expect(
      JSON.parse([...log.warn.mock.calls, ...log.error.mock.calls][0][0])
        .transport_code
    ).toBe(error.name === "TimeoutError" ? "TIMEOUT" : "ENOTFOUND")
    expect(
      JSON.stringify([...log.warn.mock.calls, ...log.error.mock.calls])
    ).not.toMatch(/private|secret/)
  }
})
it("preserves failure behavior when the warning logger throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private", { status: 400 }))
  )
  await expect(
    new RazorpayGateway("key", "secret", {
      info: () => {},
      warn: () => {
        throw Error("logger")
      },
    }).request("orders")
  ).rejects.toThrow(
    "Razorpay request failed; reconcile gateway state before retrying"
  )
})
