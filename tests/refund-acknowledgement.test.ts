import { afterEach, expect, it, vi } from "vitest"
import { RazorpayGateway, type Entity } from "../src/gateway"
import {
  acknowledgeProcessedRefund,
  refundAcknowledgementReader,
} from "../src/refund-acknowledgement"
const expected = {
  refund_id: "rfnd_fixture",
  payment_id: "pay_fixture",
  session_id: "payses_fixture",
  amount: 100,
  currency: "INR" as const,
}
const processed: Entity = {
  id: expected.refund_id,
  payment_id: expected.payment_id,
  amount: 100,
  currency: "INR",
  status: "processed",
}
afterEach(() => vi.restoreAllMocks())
function fixture(response: unknown, status = 200) {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      expect(init?.method).toBe("GET")
      return new Response(JSON.stringify(response), { status })
    })
  const gateway = new RazorpayGateway({
    mode: "test",
    key_id: "rzp_test_fixture",
    key_secret: "fixture",
    log_level: "none",
    fetch: transport,
  })
  return { transport, reader: refundAcknowledgementReader(gateway) }
}
it("offers a frozen GET-only capability and acknowledges exact existing funds", async () => {
  const { reader, transport } = fixture(processed)
  expect(Object.keys(reader)).toEqual(["get"])
  expect(Object.isFrozen(reader)).toBe(true)
  await expect(acknowledgeProcessedRefund(reader, expected)).resolves.toEqual(
    processed
  )
  expect(transport).toHaveBeenCalledTimes(1)
})
it.each([404, 500])(
  "never falls back to a refund POST on HTTP %s",
  async (status) => {
    const { reader, transport } = fixture({}, status)
    await expect(acknowledgeProcessedRefund(reader, expected)).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  }
)
it.each([
  { id: "rfnd_other" },
  { payment_id: "pay_other" },
  { amount: 101 },
  { currency: "AUD" },
  { status: "pending" },
  { status: "failed" },
  { notes: { medusa_refund_key: "unexpected" } },
])(
  "rejects changed or unprocessed acknowledgement %j without a monetary fallback",
  async (changes) => {
    const { reader, transport } = fixture({ ...processed, ...changes })
    await expect(acknowledgeProcessedRefund(reader, expected)).rejects.toThrow(
      "exact processed"
    )
    expect(transport).toHaveBeenCalledTimes(1)
  }
)
it("verifies the original operation hash and native session", async () => {
  const operation_hash = "a".repeat(64)
  const { reader } = fixture({
    ...processed,
    notes: {
      medusa_refund_key: operation_hash,
      medusa_payment_session_id: expected.session_id,
    },
  })
  await expect(
    acknowledgeProcessedRefund(reader, { ...expected, operation_hash })
  ).resolves.toBeDefined()
  await expect(
    acknowledgeProcessedRefund(reader, {
      ...expected,
      operation_hash: "b".repeat(64),
    })
  ).rejects.toThrow()
  await expect(
    acknowledgeProcessedRefund(reader, {
      ...expected,
      operation_hash,
      session_id: "payses_other",
    })
  ).rejects.toThrow()
})
it("replays acknowledgements with only GET requests", async () => {
  const { reader, transport } = fixture(processed)
  await Promise.all(
    Array.from({ length: 5 }, () =>
      acknowledgeProcessedRefund(reader, expected)
    )
  )
  expect(transport).toHaveBeenCalledTimes(5)
})
it("does not retry a transport failure", async () => {
  const { reader, transport } = fixture(processed)
  transport.mockRejectedValueOnce(new Error("fixture disconnect"))
  await expect(acknowledgeProcessedRefund(reader, expected)).rejects.toThrow()
  expect(transport).toHaveBeenCalledTimes(1)
})
it("validates acknowledgement identity before gateway access", async () => {
  const { reader, transport } = fixture(processed)
  await expect(
    acknowledgeProcessedRefund(reader, {
      ...expected,
      refund_id: "../../refund",
    })
  ).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
})
