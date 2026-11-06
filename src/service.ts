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
  CancelPaymentInput,
  DeletePaymentInput,
  RetrievePaymentInput,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { RazorpayGateway, type Entity, type Gateway } from "./gateway"
import { minor, verify } from "./security"
export type Options = {
  mode: "test"
  key_id: string
  key_secret: string
  webhook_secret?: string
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
  constructor(container: Record<string, unknown>, options: Options) {
    super(container, options)
    RazorpayProvider.validateOptions(options)
    this.options = options
    this.api = new RazorpayGateway(options.key_id, options.key_secret)
  }
  static validateOptions(options: Record<string, unknown>) {
    if (
      options.mode !== "test" ||
      typeof options.key_id !== "string" ||
      !/^rzp_test_[A-Za-z0-9]+$/.test(options.key_id)
    )
      throw new Error("Razorpay requires test mode and a test key")
    if (
      typeof options.key_secret !== "string" ||
      !options.key_secret.trim() ||
      (options.webhook_secret !== undefined &&
        (typeof options.webhook_secret !== "string" ||
          !options.webhook_secret.trim()))
    )
      throw new Error("Razorpay test secrets must be configured privately")
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
    const order = await this.api.request<Entity>("orders/" + d.order_id)
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
      const payment = await this.api.request<Entity>("payments/" + id)
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
    const list = await this.api.request<{ items: Entity[] }>(
      "orders/" + d.order_id + "/payments"
    )
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
      p.order_id !== d.order_id ||
      p.amount !== d.amount ||
      p.currency !== d.currency
    )
      throw new Error("Gateway payment amount, currency or order mismatch")
  }
  private statusOf(p?: Entity) {
    return p?.status === "captured"
      ? PaymentSessionStatus.CAPTURED
      : p?.status === "authorized"
        ? PaymentSessionStatus.AUTHORIZED
        : PaymentSessionStatus.PENDING
  }
  async initiatePayment(input: InitiatePaymentInput) {
    const amount = minor(input.amount, input.currency_code)
    const session = input.context?.idempotency_key
    if (!session || !/^payses_[A-Za-z0-9]+$/.test(session))
      throw new Error("Native payment session identity required")
    const order = await this.api.request<Entity>("orders", {
      amount,
      currency: "INR",
      receipt: createHash("sha256").update(session).digest("hex").slice(0, 40),
      notes: { medusa_payment_session_id: session },
    })
    if (
      order.amount !== amount ||
      order.currency !== "INR" ||
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
  async updatePayment(input: UpdatePaymentInput) {
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
  async authorizePayment(input: AuthorizePaymentInput) {
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
  async getPaymentStatus(input: GetPaymentStatusInput) {
    return { status: this.statusOf(await this.payment(this.data(input))) }
  }
  async retrievePayment(input: RetrievePaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    return { data: { ...d, ...(p ? { payment_id: p.id } : {}) } }
  }
  async capturePayment(input: CapturePaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    if (p?.status !== "captured")
      throw new Error(
        "Awaiting gateway automatic capture; no second capture request sent"
      )
    return { data: { ...d, payment_id: p.id } }
  }
  async refundPayment(input: RefundPaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    if (!p || !["captured", "refunded"].includes(p.status))
      throw new Error("Payment has not been captured")
    const amount = minor(input.amount, d.currency)
    if (amount > d.amount) throw new Error("Refund exceeds payment amount")
    const key = input.context?.idempotency_key
    if (!key) throw new Error("Native refund idempotency key required")
    const idempotency = createHash("sha256")
      .update(d.order_id + ":" + key)
      .digest("hex")
    const refund = await this.api.request<Entity>(
      "payments/" + p.id + "/refund",
      { amount, speed: "normal" },
      { "X-Refund-Idempotency": idempotency }
    )
    if (refund.amount !== amount)
      throw new Error(
        "Refund response amount mismatch; reconcile using the same operation key"
      )
    return { data: { ...d, payment_id: p.id, last_refund_id: refund.id } }
  }
  async cancelPayment(input: CancelPaymentInput) {
    const d = this.data(input)
    const p = await this.payment(d)
    if (p && ["authorized", "captured"].includes(p.status))
      throw new Error(
        "Payment already in progress; reconcile or explicitly refund"
      )
    return { data: d }
  }
  async deletePayment(input: DeletePaymentInput) {
    return this.cancelPayment(input)
  }
  async getWebhookActionAndData(
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
    const p = await this.api.request<Entity>("payments/" + id)
    if (!p.order_id || !/^order_[A-Za-z0-9]+$/.test(p.order_id))
      throw new Error("Invalid webhook order")
    const order = await this.api.request<Entity>("orders/" + p.order_id)
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
    this.checkPayment(d, p)
    // Ignore authorization-only events until auto-capture completes. Replays fetch current state.
    if (p.status !== "captured") return { action: "not_supported" }
    return {
      action: "captured",
      data: { session_id: session, amount: order.amount / 100 },
    }
  }
}
