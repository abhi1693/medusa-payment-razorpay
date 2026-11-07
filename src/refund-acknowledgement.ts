import type { Entity, Gateway } from "./gateway"

export type RefundAcknowledgement = {
  refund_id: string
  payment_id: string
  session_id: string
  amount: number
  currency: "INR"
  operation_hash?: string
}

/** This capability has no write method or fallback to a new monetary request. */
export function refundAcknowledgementReader(
  gateway: Pick<Gateway, "get">
): Pick<Gateway, "get"> {
  return Object.freeze({ get: gateway.get.bind(gateway) })
}

/** Acknowledgement only: validate an already processed refund, never issue one. */
export async function acknowledgeProcessedRefund(
  reader: Pick<Gateway, "get">,
  expected: RefundAcknowledgement
): Promise<Entity> {
  if (
    !/^rfnd_[A-Za-z0-9]+$/.test(expected.refund_id) ||
    !/^pay_[A-Za-z0-9]+$/.test(expected.payment_id) ||
    !/^payses_[A-Za-z0-9]+$/.test(expected.session_id) ||
    !Number.isSafeInteger(expected.amount) ||
    expected.amount <= 0 ||
    expected.currency !== "INR" ||
    (expected.operation_hash !== undefined &&
      !/^[a-f0-9]{64}$/.test(expected.operation_hash))
  )
    throw new Error("Invalid refund acknowledgement identity")
  const refund = await reader.get<Entity>("refunds/" + expected.refund_id)
  if (
    !refund ||
    refund.id !== expected.refund_id ||
    refund.payment_id !== expected.payment_id ||
    refund.amount !== expected.amount ||
    refund.currency !== expected.currency ||
    refund.status !== "processed" ||
    refund.notes?.medusa_refund_key !== expected.operation_hash ||
    (expected.operation_hash !== undefined &&
      refund.notes?.medusa_payment_session_id !== expected.session_id)
  )
    throw new Error(
      "Refund acknowledgement requires the exact processed gateway operation"
    )
  return refund
}
