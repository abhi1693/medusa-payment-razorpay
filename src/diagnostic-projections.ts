// Deliberately flat projections. Never copy arbitrary body/notes/error metadata.
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function amount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? value : undefined
}
export function gatewayRequestProjection(
  body: unknown,
  headers: Record<string, string>
) {
  const data = object(body),
    notes = object(data.notes)
  const key = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-refund-idempotency"
  )?.[1]
  return {
    body_amount_paise: amount(data.amount),
    body_field_count: Object.keys(data).length,
    body_speed: ["normal", "optimum"].includes(String(data.speed))
      ? data.speed
      : undefined,
    body_currency: data.currency === "INR" ? "INR" : undefined,
    body_notes_count: Object.keys(notes).length,
    body_receipt_present: data.receipt !== undefined,
    body_idempotency_present: typeof key === "string" && key.length > 0,
    body_idempotency_length: typeof key === "string" ? key.length : 0,
    body_session_note_present: notes.medusa_payment_session_id !== undefined,
    body_operation_note_present: notes.medusa_refund_key !== undefined,
  }
}
export function gatewayResponseProjection(
  body: unknown,
  requestIdPresent: boolean
) {
  const data = object(body),
    error = object(data.error)
  return {
    response_request_id_present: requestIdPresent,
    provider_code: typeof error.code === "string" ? error.code : undefined,
    category:
      error.description === "invalid request sent"
        ? "invalid_request"
        : "unclassified",
    provider_source: error.source,
    provider_step: error.step,
    provider_reason: error.reason,
    provider_field_present: error.field !== undefined,
    provider_metadata_count: Object.keys(object(error.metadata)).length,
    response_identity_present: typeof data.id === "string",
    response_amount_paise: amount(data.amount),
    response_currency: data.currency === "INR" ? "INR" : undefined,
    response_refund_status: ["pending", "processed", "failed"].includes(
      String(data.status)
    )
      ? data.status
      : undefined,
    response_speed: ["normal", "instant", "optimum"].includes(
      String(data.speed_processed)
    )
      ? data.speed_processed
      : undefined,
  }
}
