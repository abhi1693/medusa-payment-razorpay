import {
  validateRazorpayCredentials,
  type RazorpayCredentials,
} from "./configuration"
import { randomUUID } from "node:crypto"
import {
  createLogger,
  type LoggerSink,
  type LogLevel,
  type PluginLogger,
  type ActiveLogLevel,
  type LogContext,
} from "./logger"
export interface Entity {
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
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type GatewayFailureKind = "http" | "transport" | "response"
export interface Gateway {
  get<T>(path: string, timeoutMs?: number): Promise<T>
  post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<T>
}
export interface GatewayOptions extends RazorpayCredentials {
  logger?: LoggerSink
  log_level?: LogLevel
  fetch?: typeof fetch
  timeout_ms?: number
}
export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly method: HttpMethod,
    readonly kind: GatewayFailureKind,
    readonly status?: number
  ) {
    super(message)
    this.name = "GatewayRequestError"
  }
}
export class RazorpayGateway implements Gateway {
  private readonly authorization: string
  private readonly logger: PluginLogger
  private readonly transport: typeof fetch
  private readonly timeoutMs: number
  constructor(options: GatewayOptions) {
    validateRazorpayCredentials(options)
    this.timeoutMs = options.timeout_ms ?? 15000
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 15000
    )
      throw new Error("Invalid Razorpay request timeout")
    this.authorization =
      "Basic " +
      Buffer.from(options.key_id + ":" + options.key_secret).toString("base64")
    this.logger = createLogger({
      sink: options.logger,
      level: options.log_level,
    })
    this.transport = options.fetch || ((...args) => globalThis.fetch(...args))
  }
  get<T>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
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
  /** Compatibility adapter; plugin internals use explicit HTTP verbs. */
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
    method: HttpMethod,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("://") ||
      path.split("?")[0].split("/").includes("..")
    )
      throw new Error("Invalid relative Razorpay API path")
    const started = Date.now(),
      context: LogContext = { method, path, correlation: randomUUID() }
    let status: number | undefined,
      payload: unknown,
      rawResponse: string | undefined
    const log = (
      level: ActiveLogLevel,
      message: string,
      data: LogContext = {}
    ): void =>
      this.logger[level](message, {
        ...context,
        ...data,
        duration_ms: Math.max(0, Date.now() - started),
      })
    const requestFailure = (
      kind: GatewayFailureKind,
      existing?: GatewayRequestError
    ): GatewayRequestError => {
      const failure =
        existing ??
        new GatewayRequestError(
          kind === "http"
            ? "Razorpay request failed; reconcile gateway state before retrying"
            : kind === "response"
              ? "Razorpay response invalid; reconcile gateway state before retrying"
              : "Razorpay request unavailable; reconcile gateway state before retrying",
          method,
          kind,
          status
        )
      const severity: ActiveLogLevel =
        status === 401 || status === 403
          ? "critical"
          : status !== undefined && status < 500 && kind === "http"
            ? "warning"
            : "error"
      const message: Record<GatewayFailureKind, string> = {
        http: "Razorpay returned an unsuccessful HTTP response",
        response: "Razorpay returned invalid JSON",
        transport: "Razorpay transport failed",
      }
      log(severity, message[kind], {
        http_status: status,
        reconciliation_required: method !== "GET",
      })
      return failure
    }
    let response: Response
    log("debug", "Sending Razorpay API request", { request: body })
    try {
      response = await this.transport("https://api.razorpay.com/v1/" + path, {
        method,
        headers: {
          ...headers,
          Authorization: this.authorization,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(
          Math.min(this.timeoutMs, Math.max(1, timeoutMs))
        ),
        redirect: "error",
      })
      status = response.status
      rawResponse = await response.text()
      payload = status === 204 ? undefined : JSON.parse(rawResponse)
    } catch (error) {
      const kind: GatewayFailureKind =
        status !== undefined && status >= 400
          ? "http"
          : error instanceof SyntaxError
            ? "response"
            : "transport"
      throw requestFailure(
        kind,
        error instanceof GatewayRequestError ? error : undefined
      )
    } finally {
      if (status !== undefined)
        log("debug", "Received Razorpay API response", {
          http_status: status,
          response: payload === undefined ? rawResponse : payload,
        })
    }
    if (!response.ok) throw requestFailure("http")
    log(method === "GET" ? "debug" : "info", "Razorpay API request completed", {
      http_status: status,
    })
    return payload as T
  }
}
