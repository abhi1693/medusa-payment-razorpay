import { randomUUID } from "node:crypto"
export type Entity = {
  id: string
  amount: number
  currency: string
  status: string
  order_id?: string
  payment_id?: string
  amount_refunded?: number
  notes?: Record<string, string>
  receipt?: string
}
export interface Gateway {
  request<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T>
}
export type GatewayLogger = {
  info(message: string): void
  warn(message: string): void
}
function operation(path: string) {
  if (path === "orders") return "create_order"
  if (/^payments\/[^/]+\/refund$/.test(path)) return "create_refund"
  if (/^payments\/[^/]+\/refunds(?:\?|$)/.test(path)) return "list_refunds"
  if (/^payments\/[^/]+$/.test(path)) return "fetch_payment"
  if (/^orders\/[^/]+\/payments$/.test(path)) return "list_payments"
  if (/^orders\/[^/]+$/.test(path)) return "fetch_order"
  if (/^refunds\/[^/]+$/.test(path)) return "fetch_refund"
  return "other"
}
function providerError(value: unknown) {
  const error =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).error
      : undefined
  const detail =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  const codes = [
    "BAD_REQUEST_ERROR",
    "GATEWAY_ERROR",
    "SERVER_ERROR",
    "AUTHENTICATION_ERROR",
  ]
  return {
    provider_code: codes.includes(String(detail.code))
      ? detail.code
      : "unrecognized",
    category:
      detail.description === "invalid request sent"
        ? "invalid_request"
        : "unclassified",
  }
}
export class RazorpayGateway implements Gateway {
  constructor(
    private key: string,
    private secret: string,
    private logger: GatewayLogger = console
  ) {}
  async request<T>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const correlation = randomUUID()
    const started = Date.now()
    const action = operation(path)
    const emit = (level: "info" | "warn", fields: Record<string, unknown>) => {
      try {
        this.logger[level](
          JSON.stringify({
            event: "razorpay.gateway",
            correlation,
            operation: action,
            ...fields,
            duration_ms: Math.max(0, Date.now() - started),
          })
        )
      } catch {
        /* Observability must not alter financial outcomes. */
      }
    }
    let response: Response
    try {
      response = await fetch("https://api.razorpay.com/v1/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(this.key + ":" + this.secret).toString("base64"),
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ""
      const cause =
        error && typeof error === "object"
          ? (error as { cause?: { code?: unknown } }).cause
          : undefined
      const code = cause?.code
      const transport = [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      ].includes(String(code))
        ? code
        : name === "TimeoutError"
          ? "TIMEOUT"
          : name === "AbortError"
            ? "ABORTED"
            : "UNCLASSIFIED"
      emit("warn", {
        outcome: "transport_error",
        transport_code: transport,
        reconciliation_required: true,
      })
      throw new Error(
        "Razorpay request unavailable; reconcile gateway state before retrying"
      )
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined)
      emit("warn", {
        outcome: "http_error",
        http_status: response.status,
        ...providerError(detail),
        reconciliation_required: true,
      })
      throw new Error(
        "Razorpay request failed; reconcile gateway state before retrying"
      )
    }
    let result: T
    try {
      result = (await response.json()) as T
    } catch {
      emit("warn", {
        outcome: "invalid_response",
        http_status: response.status,
        reconciliation_required: true,
      })
      throw new Error(
        "Razorpay response invalid; reconcile gateway state before retrying"
      )
    }
    if (action === "create_refund")
      emit("info", {
        outcome: "response_received",
        http_status: response.status,
      })
    return result
  }
}
