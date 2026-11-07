import { inrMajorUnits } from "./amounts"
import {
  validateRazorpayCredentials,
  type RazorpayCredentials,
} from "./configuration"
import {
  createLogger,
  validateLogLevel,
  type LogLevel,
  type LoggerSink,
  type PluginLogger,
} from "./logger"
import { createHash } from "node:crypto"
import {
  AbstractPaymentProvider,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  InitiatePaymentInput,
  UpdatePaymentInput,
  AuthorizePaymentInput,
  GetPaymentStatusInput,
  CapturePaymentInput,
  RefundPaymentInput,
  RefundPaymentOutput,
  CancelPaymentInput,
  DeletePaymentInput,
  RetrievePaymentInput,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  GatewayRequestError,
  RazorpayGateway,
  type Entity,
  type Gateway,
} from "./gateway"
import { RazorpayRefundRejectedError } from "./razorpay-refund-rejected-error"
import { minor, verify } from "./security"
import { GatewayRefundReconciliationError } from "./gateway-refund-reconciliation-error"
import { GatewayRefundPendingError } from "./gateway-refund-pending-error"
import { observedRefundExecution } from "./refund-import-context"
export type RefundExecutionGuard = (
  context: { session_id: string },
  execute: () => Promise<RefundPaymentOutput>
) => Promise<RefundPaymentOutput>
export type Options = RazorpayCredentials & {
  log_level?: LogLevel
  webhook_secret?: string
  refund_guard?: RefundExecutionGuard
}
type Data = Record<string, unknown> & {
  order_id: string
  session_id: string
  amount: number
  currency: "INR"
  payment_id?: string
  client?: Record<string, unknown>
}
export default class RazorpayProvider extends AbstractPaymentProvider<Options> {
  static identifier = "razorpay"
  protected api: Gateway
  private options: Options
  private log: PluginLogger
  constructor(
    container: Record<string, unknown> & { logger?: LoggerSink },
    options: Options
  ) {
    super(container, options)
    RazorpayProvider.validateOptions(options)
    this.options = options
    this.log = createLogger({
      sink: container.logger,
      level: options.log_level,
    })
    this.api = new RazorpayGateway({
      mode: options.mode,
      key_id: options.key_id,
      key_secret: options.key_secret,
      logger: container.logger,
      log_level: options.log_level,
    })
  }
  private async lifecycle<T>(
    action: string,
    execute: () => Promise<T>
  ): Promise<T> {
    this.log.debug(`Razorpay ${action} started`)
    try {
      const result = await execute()
      this.log.info(`Razorpay ${action} completed`)
      return result
    } catch (error) {
      this.log.warning(`Razorpay ${action} failed`)
      throw error
    }
  }
  async initiatePayment(input: InitiatePaymentInput) {
    return this.lifecycle("initiatePayment", () =>
      this.initiatePaymentImpl(input)
    )
  }
  async updatePayment(input: UpdatePaymentInput) {
    return this.lifecycle("updatePayment", () => this.updatePaymentImpl(input))
  }
  async authorizePayment(input: AuthorizePaymentInput) {
    return this.lifecycle("authorizePayment", () =>
      this.authorizePaymentImpl(input)
    )
  }
  async getPaymentStatus(input: GetPaymentStatusInput) {
    return this.lifecycle("getPaymentStatus", () =>
      this.getPaymentStatusImpl(input)
    )
  }
  async retrievePayment(input: RetrievePaymentInput) {
    return this.lifecycle("retrievePayment", () =>
      this.retrievePaymentImpl(input)
    )
  }
  async capturePayment(input: CapturePaymentInput) {
    return this.lifecycle("capturePayment", () =>
      this.capturePaymentImpl(input)
    )
  }
  async refundPayment(input: RefundPaymentInput) {
    return this.lifecycle("refundPayment", () => this.refundPaymentImpl(input))
  }
  async cancelPayment(input: CancelPaymentInput) {
    return this.lifecycle("cancelPayment", () => this.cancelPaymentImpl(input))
  }
  async deletePayment(input: DeletePaymentInput) {
    return this.lifecycle("deletePayment", () => this.deletePaymentImpl(input))
  }
  async getWebhookActionAndData(
    input: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    return this.lifecycle("getWebhookActionAndData", () =>
      this.getWebhookActionAndDataImpl(input)
    )
  }
  static validateOptions(options: Record<string, unknown>) {
    validateLogLevel(options.log_level)
    validateRazorpayCredentials(options)
    if (
      options.refund_guard !== undefined &&
      typeof options.refund_guard !== "function"
    )
      throw new Error("Razorpay refund guard must be a function")
    if (
      options.webhook_secret !== undefined &&
      (typeof options.webhook_secret !== "string" ||
        !options.webhook_secret.trim())
    )
      throw new Error("Razorpay webhook secret must be configured privately")
    if (options.mode === "live" && !options.webhook_secret)
      throw new Error("Razorpay live mode requires a webhook secret")
  }
  private data(input: { data?: Record<string, unknown> }): Data {
    const d = input.data as Data | undefined
    if (
      !d ||
      !/^order_[A-Za-z0-9]+$/.test(d.order_id) ||
      !/^payses_[A-Za-z0-9]+$/.test(d.session_id) ||
      !Number.isSafeInteger(d.amount) ||
      d.amount <= 0 ||
      d.currency !== "INR"
    )
      throw new Error("Invalid stored Razorpay session")
    return d
  }
  private async order(d: Data) {
    const order = await this.api.get<Entity>("orders/" + d.order_id)
    if (
      order.id !== d.order_id ||
      order.amount !== d.amount ||
      order.currency !== d.currency ||
      order.notes?.medusa_payment_session_id !== d.session_id
    )
      throw new Error("Gateway order does not match stored session")
    return order
  }
  private async payment(d: Data): Promise<Entity | undefined> {
    await this.order(d)
    const client = d.client,
      callbackId = client?.razorpay_payment_id
    if (callbackId !== undefined) {
      if (
        client?.razorpay_order_id !== d.order_id ||
        typeof callbackId !== "string"
      )
        throw new Error("Checkout order mismatch")
      verify(
        d.order_id + "|" + callbackId,
        client.razorpay_signature,
        this.options.key_secret
      )
    }
    const fetchPayment = async (id: unknown) => {
      if (typeof id !== "string" || !/^pay_[A-Za-z0-9]+$/.test(id))
        throw new Error("Invalid gateway payment ID")
      const payment = await this.api.get<Entity>("payments/" + id)
      if (payment.id !== id)
        throw new Error("Gateway payment identity mismatch")
      this.checkPayment(d, payment)
      return payment
    }
    const previous = d.payment_id ? await fetchPayment(d.payment_id) : undefined
    if (previous && previous.status !== "failed") {
      if (callbackId !== undefined && callbackId !== previous.id)
        throw new Error(
          "Another payment attempt is already in progress or settled; reconcile before retrying"
        )
      return previous
    }
    // A failed attempt is terminal. A later attempt can belong to this same order,
    // but a still-authorized/captured/refunded association is never silently replaced.
    if (callbackId !== undefined && callbackId !== previous?.id)
      return fetchPayment(callbackId)
    const list = await this.api.get<{ items: Entity[] }>(
      "orders/" + d.order_id + "/payments"
    )
    if (
      !Array.isArray(list.items) ||
      list.items.some((p) => !p || typeof p !== "object" || Array.isArray(p))
    )
      throw new Error("Invalid gateway payment listing")
    const candidates = list.items.filter((p) =>
      ["authorized", "captured"].includes(p.status)
    )
    if (candidates.length > 1)
      throw new Error(
        "Multiple successful payment attempts require reconciliation"
      )
    const payment = candidates[0]
    if (payment) this.checkPayment(d, payment)
    return payment ?? previous
  }
  private checkPayment(d: Data, p: Entity) {
    if (
      typeof p.id !== "string" ||
      !/^pay_[A-Za-z0-9]+$/.test(p.id) ||
      p.order_id !== d.order_id ||
      p.amount !== d.amount ||
      p.currency !== d.currency
    )
      throw new Error("Gateway payment amount, currency or order mismatch")
  }
  private statusOf(p?: Entity) {
    return p?.status === "captured"
      ? PaymentSessionStatus.CAPTURED
      : PaymentSessionStatus.PENDING
  }
  private async initiatePaymentImpl(input: InitiatePaymentInput) {
    const amount = minor(input.amount, input.currency_code)
    const session = input.context?.idempotency_key
    if (!session || !/^payses_[A-Za-z0-9]+$/.test(session))
      throw new Error("Native payment session identity required")
    const order = await this.api.post<Entity>("orders", {
      amount,
      currency: "INR",
      receipt: createHash("sha256").update(session).digest("hex").slice(0, 40),
      notes: { medusa_payment_session_id: session },
    })
    if (
      order.amount !== amount ||
      order.currency !== "INR" ||
      order.notes?.medusa_payment_session_id !== session ||
      !/^order_[A-Za-z0-9]+$/.test(order.id)
    )
      throw new Error("Invalid gateway order response")
    // Automatic capture is an account prerequisite; do not mutate account settings here.
    return {
      id: order.id,
      status: PaymentSessionStatus.PENDING,
      data: {
        order_id: order.id,
        session_id: session,
        amount,
        currency: "INR",
        key_id: this.options.key_id,
      },
    }
  }
  private async updatePaymentImpl(input: UpdatePaymentInput) {
    const d = this.data(input)
    if (minor(input.amount, input.currency_code) !== d.amount)
      throw new Error("Totals changed; initialize a fresh payment session")
    const p = await this.payment(d)
    return {
      data: {
        ...d,
        ...(p ? { payment_id: p.id } : {}),
        gateway_status: p?.status ?? "created",
      },
      status:
        p?.status === "captured"
          ? PaymentSessionStatus.CAPTURED
          : PaymentSessionStatus.PENDING,
    }
  }
  private async authorizePaymentImpl(input: AuthorizePaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    // Auto-capture only: do not place an order while funds remain merely authorized.
    return {
      data: { ...d, ...(p ? { payment_id: p.id } : {}) },
      status:
        p?.status === "captured"
          ? PaymentSessionStatus.CAPTURED
          : PaymentSessionStatus.PENDING,
    }
  }
  private async getPaymentStatusImpl(input: GetPaymentStatusInput) {
    return { status: this.statusOf(await this.payment(this.data(input))) }
  }
  private async retrievePaymentImpl(input: RetrievePaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    return { data: { ...d, ...(p ? { payment_id: p.id } : {}) } }
  }
  private async capturePaymentImpl(input: CapturePaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    if (p?.status !== "captured")
      throw new Error(
        "Awaiting gateway automatic capture; no second capture request sent"
      )
    return { data: { ...d, payment_id: p.id } }
  }
  private async refundPaymentImpl(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const d = this.data(input)
    const execute = async () => {
      try {
        return await this.refundAtGateway(input)
      } catch (error) {
        if (
          error instanceof GatewayRequestError &&
          error.method === "POST" &&
          error.kind === "http" &&
          error.status === 400
        )
          throw new RazorpayRefundRejectedError(error)
        throw error
      }
    }
    const observed = observedRefundExecution.getStore()
    if (
      observed?.session === d.session_id &&
      observed.key === input.context?.idempotency_key
    )
      return execute() // The importer owns the outer financial critical section.
    return this.options.refund_guard
      ? this.options.refund_guard({ session_id: d.session_id }, execute)
      : execute()
  }
  private async refundAtGateway(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const d = this.data(input)
    const amount = minor(input.amount, d.currency)
    // Razorpay's normal-refund API requires at least INR 1.00. Reject before
    // gateway access instead of relying on native currency epsilon tolerances.
    if (amount < 100)
      throw new Error("Razorpay refunds require at least INR 1.00")
    if (amount > d.amount) throw new Error("Refund exceeds payment amount")
    const p = await this.payment(d)
    if (!p || !["captured", "refunded"].includes(p.status))
      throw new Error("Payment has not been captured")
    const key = input.context?.idempotency_key
    if (!key) throw new Error("Native refund idempotency key required")
    const idempotency = createHash("sha256")
      .update(d.order_id + ":" + key)
      .digest("hex")
    const external = /^razorpay-observed:(rfnd_[A-Za-z0-9]+)$/.exec(key)
    const importing = observedRefundExecution.getStore()
    if (
      external &&
      (importing?.key !== key || importing.session !== d.session_id)
    )
      throw new Error(
        "Observed refund keys are reserved for the verified importer"
      )
    if (key.startsWith("razorpay-observed:") && !external)
      throw new Error("Invalid observed refund operation")
    // Reconcile a stable operation before any POST. A pending request (including
    // a Dashboard request) blocks another debit while its outcome is unknown.
    let prior: Entity | undefined
    if (!external) {
      const seen = new Set<string>()
      let finished = false
      let accepted = 0
      for (let skip = 0; skip < 500; skip += 100) {
        const page = await this.api.get<{ items: Entity[] }>(
          "payments/" + p.id + "/refunds?count=100&skip=" + skip
        )
        if (!Array.isArray(page.items))
          throw new Error("Invalid gateway refund listing")
        for (const entry of page.items) {
          if (
            !/^rfnd_[A-Za-z0-9]+$/.test(entry.id) ||
            seen.has(entry.id) ||
            entry.payment_id !== p.id ||
            entry.currency !== d.currency ||
            !Number.isSafeInteger(entry.amount) ||
            entry.amount <= 0 ||
            !["pending", "processed", "failed"].includes(entry.status)
          )
            throw new Error("Invalid or duplicated gateway refund association")
          seen.add(entry.id)
          if (entry.status !== "failed") accepted += entry.amount
          if (!Number.isSafeInteger(accepted) || accepted > d.amount)
            throw new Error("Gateway refund totals exceed payment")
          if (entry.notes?.medusa_refund_key === idempotency) {
            if (prior) throw new Error("Ambiguous gateway refund operation")
            prior = await this.api.get<Entity>("refunds/" + entry.id)
            if (
              prior.id !== entry.id ||
              prior.notes?.medusa_refund_key !== idempotency ||
              prior.notes?.medusa_payment_session_id !== d.session_id
            )
              throw new Error("Gateway refund operation detail mismatch")
          } else if (entry.status === "pending") {
            throw new GatewayRefundPendingError(entry.id)
          }
        }
        if (page.items.length < 100) {
          finished = true
          break
        }
      }
      if (!finished)
        throw new Error("Gateway refund reconciliation limit exceeded")
      if (
        !prior &&
        p.amount_refunded !== undefined &&
        p.amount_refunded !== accepted
      )
        throw new Error(
          "Gateway refund totals changed; reconcile before retrying"
        )
      if (!prior && amount > d.amount - accepted)
        throw new Error("Refund exceeds remaining gateway balance")
    }
    // Reserved observed operations acknowledge existing processed funds only.
    // No client-supplied data can turn this path into a gateway POST.
    const refund = external
      ? await this.api.get<Entity>("refunds/" + external[1])
      : prior ||
        (await this.api.post<Entity>(
          "payments/" + p.id + "/refund",
          {
            amount,
            speed: "normal",
            notes: {
              medusa_refund_key: idempotency,
              medusa_payment_session_id: d.session_id,
            },
          },
          { "X-Refund-Idempotency": idempotency }
        ))
    if (
      external &&
      (refund.id !== external[1] ||
        refund.status !== "processed" ||
        refund.notes?.medusa_refund_key !== importing?.origin_hash ||
        (importing?.origin_hash !== undefined &&
          refund.notes?.medusa_payment_session_id !== d.session_id))
    )
      throw new Error(
        "Observed refund must be processed and external to native refund execution"
      )
    if (
      !/^rfnd_[A-Za-z0-9]+$/.test(refund.id) ||
      refund.payment_id !== p.id ||
      refund.amount !== amount ||
      refund.currency !== d.currency ||
      !["pending", "processed"].includes(refund.status)
    )
      throw new Error(
        "Refund was not accepted with the expected payment, amount and currency; reconcile using the same operation key"
      )
    if (refund.status === "pending")
      throw new GatewayRefundPendingError(refund.id)
    if (!external && prior)
      throw new GatewayRefundReconciliationError(refund.id)
    // This is an immutable response snapshot, not a refreshed settlement status.
    const data = { ...d }
    delete data.last_refund_status
    return {
      data: {
        ...data,
        payment_id: p.id,
        last_refund_id: refund.id,
        last_refund_initial_status: refund.status,
      },
    }
  }
  private async cancelPaymentImpl(input: CancelPaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    if (p && ["authorized", "captured"].includes(p.status))
      throw new Error(
        "Payment already in progress; reconcile or explicitly refund"
      )
    return { data: d }
  }
  private async deletePaymentImpl(input: DeletePaymentInput) {
    return this.cancelPayment(input)
  }
  private async getWebhookActionAndDataImpl(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    if (!this.options.webhook_secret)
      throw new Error("Razorpay webhooks are not configured")
    verify(
      payload.rawData,
      payload.headers["x-razorpay-signature"],
      this.options.webhook_secret
    )
    const event = JSON.parse(payload.rawData.toString())
    if (!["payment.authorized", "payment.captured"].includes(event.event))
      return { action: "not_supported" }
    const id = event.payload?.payment?.entity?.id
    if (typeof id !== "string" || !/^pay_[A-Za-z0-9]+$/.test(id))
      throw new Error("Missing webhook payment")
    const p = await this.api.get<Entity>("payments/" + id)
    if (p.id !== id) throw new Error("Webhook payment identity mismatch")
    if (!p.order_id || !/^order_[A-Za-z0-9]+$/.test(p.order_id))
      throw new Error("Invalid webhook order")
    const order = await this.api.get<Entity>("orders/" + p.order_id)
    const session = order.notes?.medusa_payment_session_id
    if (!session || !/^payses_[A-Za-z0-9]+$/.test(session))
      return { action: "not_supported" }
    const d: Data = {
      order_id: order.id,
      session_id: session,
      amount: order.amount,
      currency: "INR",
    }
    if (order.currency !== "INR")
      throw new Error("Unsupported gateway currency")
    if (!Number.isSafeInteger(order.amount) || order.amount <= 0)
      throw new Error("Invalid gateway webhook amount")
    this.checkPayment(d, p)
    // Ignore authorization-only events until auto-capture completes. Replays fetch current state.
    if (p.status !== "captured") return { action: "not_supported" }
    return {
      action: "captured",
      data: { session_id: session, amount: inrMajorUnits(order.amount) },
    }
  }
}
