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
  request<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    operation?: string
  ): Promise<T>
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
  async request<T>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    action = "request"
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
        operation: action,
        method: body === undefined ? "GET" : "POST",
        ...fields,
        duration_ms: Math.max(0, Date.now() - started),
      })
    emit("debug", { outcome: "started" })
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
      emit("error", {
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
          reconciliation_required: true,
        }
      )
      throw new Error(
        "Razorpay request failed; reconcile gateway state before retrying"
      )
    }
    let result: T
    try {
      result = (await response.json()) as T
    } catch {
      emit("error", {
        outcome: "invalid_response",
        http_status: response.status,
        reconciliation_required: true,
      })
      throw new Error(
        "Razorpay response invalid; reconcile gateway state before retrying"
      )
    }
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
