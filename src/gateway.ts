import {
  gatewayRequestProjection,
  gatewayResponseProjection,
} from "./diagnostic-projections"
import {
  diagnostics,
  gatewayLogEvent,
  type DiagnosticLogger,
  type LogLevel,
} from "./diagnostics"
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
  get<T>(path: string, timeoutMs?: number): Promise<T>
  post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<T>
}
export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly outcome: "http_error" | "transport_error" | "invalid_response",
    readonly status?: number
  ) {
    super(message)
    this.name = "GatewayRequestError"
  }
}
export type GatewayLogger = DiagnosticLogger
function providerError(value: unknown) {
  const error =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).error
      : undefined
  const detail =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  return {
    provider_code:
      typeof detail.code === "string" ? detail.code : "UNRECOGNIZED",
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
    private logger: GatewayLogger = console,
    private logLevel: LogLevel = "info"
  ) {}
  get<T>(path: string, timeoutMs = 15000): Promise<T> {
    return this.execute("GET", path, undefined, {}, timeoutMs)
  }
  post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return this.execute("POST", path, body, headers)
  }
  put<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return this.execute("PUT", path, body, headers)
  }
  patch<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return this.execute("PATCH", path, body, headers)
  }
  delete<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    return this.execute("DELETE", path, undefined, headers)
  }
  /** Compatibility adapter; plugin internals use explicit verbs. */
  request<T>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return body === undefined
      ? this.get<T>(path)
      : this.post<T>(path, body, headers)
  }
  private async execute<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 15000
  ): Promise<T> {
    const correlation = randomUUID()
    const started = Date.now()
    const log = diagnostics(this.logger, this.logLevel)
    const emit = (
      level: "debug" | "info" | "warning" | "error" | "critical",
      fields: Record<string, unknown>
    ) =>
      log(level, gatewayLogEvent, {
        correlation,
        operation: "http_request",
        method,
        ...fields,
        duration_ms: Math.max(0, Date.now() - started),
      })
    emit("debug", { outcome: "started" })
    if (body !== undefined)
      emit("debug", {
        outcome: "request_projection",
        ...gatewayRequestProjection(body, headers),
      })
    let response: Response
    try {
      response = await fetch("https://api.razorpay.com/v1/" + path, {
        method,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(this.key + ":" + this.secret).toString("base64"),
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(15000, Math.max(1, timeoutMs))),
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
      emit("error", {
        outcome: "transport_error",
        transport_code: transport,
        reconciliation_required: method !== "GET",
      })
      throw new GatewayRequestError(
        "Razorpay request unavailable; reconcile gateway state before retrying",
        method,
        "transport_error"
      )
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined)
      emit("debug", {
        outcome: "response_projection",
        http_status: response.status,
        ...gatewayResponseProjection(
          detail,
          response.headers.has("x-razorpay-request-id") ||
            response.headers.has("x-request-id")
        ),
      })
      emit(
        response.status === 401 || response.status === 403
          ? "critical"
          : response.status >= 500
            ? "error"
            : "warning",
        {
          outcome: "http_error",
          http_status: response.status,
          ...providerError(detail),
          reconciliation_required: method !== "GET",
        }
      )
      throw new GatewayRequestError(
        "Razorpay request failed; reconcile gateway state before retrying",
        method,
        "http_error",
        response.status
      )
    }
    if (response.status === 204) {
      emit("info", { outcome: "response_received", http_status: 204 })
      return undefined as T
    }
    let result: T
    try {
      result = (await response.json()) as T
    } catch {
      emit("error", {
        outcome: "invalid_response",
        http_status: response.status,
        reconciliation_required: method !== "GET",
      })
      throw new GatewayRequestError(
        "Razorpay response invalid; reconcile gateway state before retrying",
        method,
        "invalid_response",
        response.status
      )
    }
    emit("debug", {
      outcome: "response_projection",
      http_status: response.status,
      ...gatewayResponseProjection(
        result,
        response.headers.has("x-razorpay-request-id") ||
          response.headers.has("x-request-id")
      ),
    })
    if (body !== undefined)
      emit("info", {
        outcome: "response_received",
        http_status: response.status,
      })
    if (body === undefined)
      emit("debug", {
        outcome: "response_received",
        http_status: response.status,
      })
    return result
  }
}
