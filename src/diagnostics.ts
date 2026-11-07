export const LOG_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
  "none",
] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
export type DiagnosticLogger = Partial<
  Record<"debug" | "info" | "warn" | "error", (message: string) => void>
>
export function validateLogLevel(value: unknown): LogLevel {
  if (value === undefined) return "info"
  if (!LOG_LEVELS.includes(value as LogLevel))
    throw new Error("Invalid Razorpay log level")
  return value as LogLevel
}
type Field = (value: unknown) => string | number | boolean | undefined
const sensitive =
  /(?:secret|password|authorization|cookie|private|customer|token|signature|rzp_|pay_|payses_|order_|rfnd_|ref_|@)/i
// Labels are code-owned classifications, never exception messages, URLs or free text.
const label: Field = (value) =>
  typeof value === "string" &&
  /^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(value) &&
  !sensitive.test(value)
    ? value
    : undefined
const number: Field = (value) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
export const logFields = {
  label,
  number,
  boolean: ((value: unknown) =>
    typeof value === "boolean" ? value : undefined) as Field,
  uuid: ((value: unknown) =>
    typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)
      ? value
      : undefined) as Field,
  // Provider codes have their own bounded syntax; descriptions and metadata are never accepted.
  token: ((value: unknown) =>
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) &&
    !sensitive.test(value)
      ? value
      : undefined) as Field,
  code: ((value: unknown) =>
    typeof value === "string" &&
    /^[A-Z][A-Z0-9_]{1,47}$/.test(value) &&
    !sensitive.test(value)
      ? value
      : undefined) as Field,
}
export function defineLogEvent(name: string, schema: Record<string, Field>) {
  if (
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name) ||
    name.length > 80 ||
    sensitive.test(name)
  )
    throw new Error("Invalid diagnostic event name")
  return { name, schema }
}
export const gatewayLogEvent = defineLogEvent("razorpay.gateway", {
  operation: label,
  outcome: label,
  method: logFields.code,
  provider_code: logFields.code,
  category: label,
  transport_code: logFields.code,
  correlation: logFields.uuid,
  http_status: number,
  duration_ms: number,
  reconciliation_required: logFields.boolean,
  body_amount_paise: number,
  body_field_count: number,
  body_notes_count: number,
  body_speed: logFields.token,
  body_currency: logFields.token,
  body_receipt_present: logFields.boolean,
  body_idempotency_present: logFields.boolean,
  body_idempotency_length: number,
  body_session_note_present: logFields.boolean,
  body_operation_note_present: logFields.boolean,
  response_amount_paise: number,
  response_currency: logFields.token,
  response_refund_status: logFields.token,
  response_speed: logFields.token,
  response_identity_present: logFields.boolean,
  response_request_id_present: logFields.boolean,
  provider_source: logFields.token,
  provider_step: logFields.token,
  provider_reason: logFields.token,
  provider_field_present: logFields.boolean,
  provider_metadata_count: number,
})
export const lifecycleLogEvent = defineLogEvent("razorpay.lifecycle", {
  operation: label,
  outcome: label,
})
export function diagnostics(
  logger: DiagnosticLogger = console,
  threshold: LogLevel = "info"
) {
  const minimum = LOG_LEVELS.indexOf(validateLogLevel(threshold))
  return (
    level: Exclude<LogLevel, "none">,
    event: ReturnType<typeof defineLogEvent>,
    fields: Record<string, unknown>
  ) => {
    if (minimum === 5 || LOG_LEVELS.indexOf(level) < minimum) return
    const safe: Record<string, unknown> = { event: event.name, level }
    for (const [key, parse] of Object.entries(event.schema)) {
      if (key === "event" || key === "level") continue
      const value = parse(fields[key])
      if (value !== undefined) safe[key] = value
    }
    const method =
      level === "warning" ? "warn" : level === "critical" ? "error" : level
    const sink = logger[method] || logger.info
    try {
      sink?.call(logger, JSON.stringify(safe))
    } catch {
      /* Observability cannot change financial outcomes. */
    }
  }
}
