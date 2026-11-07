import { createHash } from "node:crypto"
import type {
  MedusaContainer,
  IPaymentModuleService,
  IOrderModuleService,
  IEventBusModuleService,
} from "@medusajs/framework/types"
import {
  Modules,
  ContainerRegistrationKeys,
  BigNumber,
  OrderChangeType,
  ChangeActionType,
  PaymentEvents,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  gatewayReader,
  reconcileRazorpayPayment,
  type ReconciliationOptions,
} from "./reconciliation"
import { record } from "./records"
import { PendingRefundRecoveryError } from "./refund-recovery-error"
import { observedRefundExecution } from "./refund-import-context"

export type RefundImportOptions = ReconciliationOptions & {
  coordinate: <T>(sessions: string[], work: () => Promise<T>) => Promise<T>
}
const reference = "razorpay_refund"
// Public FindConfig ORM options force current relations after another worker commits.
const fresh = { options: { refresh: true } }
function major(n: number) {
  const negative = n < 0
  const a = BigInt(Math.abs(n))
  return (
    (negative ? "-" : "") + a / 100n + "." + String(a % 100n).padStart(2, "0")
  )
}
function paise(value: unknown) {
  const n = new BigNumber(value as string).bigNumber!.multipliedBy(100)
  if (!n.isInteger() || !n.isFinite() || n.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid native refund accounting amount")
  return n.toNumber()
}
function operation(order: string, key: string) {
  return createHash("sha256")
    .update(order + ":" + key)
    .digest("hex")
}
// Internal worker API. The caller must authenticate the webhook (or be an
// authorized operator). Every remote entity is independently fetched/verified.
export async function importRazorpayRefund(
  scope: MedusaContainer,
  event: { refund_id: string; payment_id: string },
  options: RefundImportOptions
) {
  if (
    !/^rfnd_[A-Za-z0-9]+$/.test(event.refund_id) ||
    !/^pay_[A-Za-z0-9]+$/.test(event.payment_id)
  )
    throw new Error("Invalid refund import identity")
  const get = gatewayReader(options)
  const gatewayPayment = await get("payments/" + event.payment_id)
  if (
    gatewayPayment.id !== event.payment_id ||
    !/^order_[A-Za-z0-9]+$/.test(String(gatewayPayment.order_id))
  )
    throw new Error("Refund payment identity mismatch")
  if (
    gatewayPayment.captured === false ||
    !["captured", "refunded"].includes(String(gatewayPayment.status))
  )
    return { status: "ignored", reason: "Uncaptured automatic refund" }
  const gatewayOrder = await get("orders/" + gatewayPayment.order_id)
  if (gatewayOrder.id !== gatewayPayment.order_id)
    throw new Error("Refund order identity mismatch")
  const session = record(gatewayOrder.notes).medusa_payment_session_id
  if (typeof session !== "string" || !/^payses_[A-Za-z0-9]+$/.test(session))
    return { status: "ignored", reason: "Unassociated gateway order" }
  return options.coordinate([session], async () => {
    const payments = scope.resolve<IPaymentModuleService>(Modules.PAYMENT)
    const sessions = await payments.listPaymentSessions(
      { id: session },
      { ...fresh, relations: ["payment"], take: 1 }
    )
    const nativeId = record(record(sessions[0]).payment).id
    if (typeof nativeId !== "string")
      throw new Error("Native payment association not yet available")
    const report = await reconcileRazorpayPayment(scope, nativeId, options)
    if (
      !report.complete ||
      report.gateway_payment_id !== event.payment_id ||
      report.native_captured_paise !== report.amount_paise ||
      !["captured", "refunded"].includes(String(report.gateway_status))
    )
      throw new Error("Incomplete captured payment reconciliation")
    const refund = await get("refunds/" + event.refund_id)
    if (
      refund.id !== event.refund_id ||
      refund.payment_id !== event.payment_id ||
      refund.currency !== "INR" ||
      !Number.isSafeInteger(refund.amount) ||
      Number(refund.amount) <= 0 ||
      Number(refund.amount) > Number(report.amount_paise) ||
      !["pending", "processed", "failed"].includes(String(refund.status))
    )
      throw new Error("Refund identity, currency, amount or status mismatch")
    const listed = report.gateway_refunds.find((r) => r.id === event.refund_id)
    if (
      !listed ||
      listed.amount_paise !== refund.amount ||
      listed.status !== refund.status
    )
      throw new Error("Gateway refund changed during import; retry observation")
    const native = await payments.retrievePayment(nativeId, {
      ...fresh,
      relations: ["refunds"],
    })
    const refunds = native.refunds || []
    // Native-created gateway refunds carry an opaque operation hash. This
    // separates them from Dashboard refunds even if the webhook races commit.
    const nativeKey = record(refund.notes).medusa_refund_key
    if (nativeKey !== undefined) {
      const match = refunds.find(
        (r) =>
          operation(
            String(report.gateway_order_id),
            String(record(r).idempotency_key || r.id)
          ) === nativeKey
      )
      if (
        !match ||
        record(match).status !== "succeeded" ||
        paise(match.amount) !== refund.amount
      )
        throw new Error(
          "Native refund operation has not committed or mismatches gateway"
        )
      if (refund.status === "failed")
        throw new Error(
          "Accepted native refund failed at gateway; accounting review required"
        )
      return {
        status: "native",
        refund_id: match.id,
        gateway_status: String(refund.status),
      }
    }
    if (refund.status !== "processed")
      return {
        status: String(refund.status),
        gateway_refund_id: event.refund_id,
      }
    if (
      report.gateway_reported_refunded_paise !==
        report.gateway_accepted_refunded_paise ||
      report.gateway_accepted_refunded_paise > Number(report.amount_paise)
    )
      throw new Error(
        "Gateway refund totals are inconsistent; retry reconciliation"
      )
    const key = "razorpay-observed:" + event.refund_id
    let existing = refunds.find((r) => record(r).idempotency_key === key)
    // All existing refunds must have individual verified associations, not just
    // matching totals. No amount-based adoption or historical fallback.
    for (const r of refunds) {
      const k = String(record(r).idempotency_key || r.id)
      const mapped = report.gateway_refunds.filter((g) => {
        if (k.startsWith("razorpay-observed:"))
          return g.id === k.slice("razorpay-observed:".length)
        return false
      })
      if (k.startsWith("razorpay-observed:")) {
        if (
          mapped.length !== 1 ||
          mapped[0].amount_paise !== paise(r.amount) ||
          mapped[0].status !== "processed"
        )
          throw new Error("Imported native refund association mismatch")
      } else {
        let found = false
        for (const g of report.gateway_refunds) {
          const detail = await get("refunds/" + g.id)
          if (
            record(detail.notes).medusa_refund_key ===
            operation(String(report.gateway_order_id), k)
          ) {
            if (
              detail.payment_id !== event.payment_id ||
              detail.amount !== paise(r.amount) ||
              detail.currency !== "INR" ||
              detail.status === "failed"
            )
              throw new Error("Native gateway refund association mismatch")
            found = true
          }
        }
        if (!found)
          throw new Error(
            "Native refund lacks a verified gateway operation association"
          )
      }
    }
    const orders = scope.resolve<IOrderModuleService>(Modules.ORDER)
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data: links } = await query.graph({
      entity: "order_payment_collection",
      fields: ["order.id"],
      filters: { payment_collection_id: native.payment_collection_id },
    })
    const orderId = record(record(links[0]).order).id
    if (links.length !== 1 || typeof orderId !== "string")
      throw new Error("Unique native order association required")
    // Query applies Medusa's current-version order projection. Refreshing a
    // populated versioned Order entity directly can include historical items.
    const readOrder = async () => {
      const { data } = await query.graph({
        entity: "order",
        fields: [
          "id",
          "status",
          "currency_code",
          "summary",
          "total",
          "credit_lines.*",
          "transactions.*",
        ],
        filters: { id: orderId },
      })
      if (data.length !== 1 || data[0].id !== orderId)
        throw new Error("Current native order projection required")
      return data[0]
    }
    const order = await readOrder()
    if (order.currency_code !== "inr" || order.status === "canceled")
      throw new Error("Order cannot accept refund import")
    const pending = paise(
      record(order.summary).raw_pending_difference ??
        record(order.summary).pending_difference ??
        0
    )
    if (!existing && pending !== 0)
      throw new Error("Native refund accounting is incomplete; retry import")
    for (const r of refunds) {
      if (r.id === existing?.id) continue
      if (
        !(order.transactions || []).some(
          (t: {
            reference?: string
            reference_id?: string
            amount?: unknown
          }) =>
            t.reference === "refund" &&
            t.reference_id === r.id &&
            paise(t.amount) === -paise(r.amount)
        )
      )
        throw new Error("Native refund order transaction not yet available")
    }
    const credit = existing
      ? record(record(record(existing).metadata).razorpay_import).credit_paise
      : Math.max(0, Number(refund.amount) + Math.min(0, pending))
    if (
      !Number.isSafeInteger(credit) ||
      Number(credit) < 0 ||
      Number(credit) > Number(refund.amount)
    )
      throw new Error("Invalid persisted import accounting intent")
    const resumePending = !!existing && record(existing).status === "pending"
    if (!existing || resumePending) {
      try {
        await observedRefundExecution.run({ session, key }, () =>
          payments.refundPayment({
            payment_id: nativeId,
            amount: major(Number(refund.amount)),
            idempotency_key: key,
            note: "Verified Razorpay Dashboard refund",
            metadata: {
              razorpay_import: {
                gateway_refund_id: event.refund_id,
                gateway_payment_id: event.payment_id,
                order_id: orderId,
                amount_paise: refund.amount,
                credit_paise: credit,
              },
            },
          })
        )
      } catch (error) {
        if (
          resumePending &&
          error instanceof MedusaError &&
          error.type === MedusaError.Types.CONFLICT
        )
          throw new PendingRefundRecoveryError()
        throw error
      }
      const updated = await payments.retrievePayment(nativeId, {
        ...fresh,
        relations: ["refunds"],
      })
      existing = updated.refunds?.find((r) => record(r).idempotency_key === key)
    }
    if (
      !existing ||
      record(existing).status !== "succeeded" ||
      paise(existing.amount) !== refund.amount
    )
      throw new Error("Native refund import has not completed")
    const intent = record(record(record(existing).metadata).razorpay_import)
    if (
      intent.gateway_refund_id !== event.refund_id ||
      intent.gateway_payment_id !== event.payment_id ||
      intent.order_id !== orderId ||
      intent.amount_paise !== refund.amount
    )
      throw new Error("Native refund import intent mismatch")
    // Each stage is recoverable through an immutable unique native reference.
    // A crash after either public API commits is recovered by querying it again.
    const transactions = await orders.listOrderTransactions({
      order_id: orderId,
      reference: "refund",
      reference_id: existing.id,
    })
    if (
      transactions.length > 1 ||
      (transactions[0] &&
        paise(transactions[0].amount) !== -Number(refund.amount))
    )
      throw new Error("Refund transaction mismatch")
    if (!transactions.length)
      await orders.addOrderTransactions({
        order_id: orderId,
        amount: major(-Number(refund.amount)),
        currency_code: "inr",
        reference: "refund",
        reference_id: existing.id,
      })
    const refreshed = await readOrder()
    const credits = (refreshed.credit_lines || []).filter(
      (c: { reference?: string; reference_id?: string; amount?: unknown }) =>
        c.reference === reference && c.reference_id === existing!.id
    )
    if (
      credits.length > 1 ||
      (credits[0] && paise(credits[0].amount) !== credit)
    )
      throw new Error("Refund credit mismatch")
    if (Number(credit) > 0 && !credits.length) {
      // Native OrderChange records are the durable stage markers. Resume our
      // own change/action after a crash; never select another user's pending
      // order change or create an unversioned credit-line row.
      const changes = await orders.listOrderChanges(
        { order_id: orderId },
        { ...fresh, relations: ["actions"], take: 501 }
      )
      if (changes.length > 500)
        throw new Error("Order change review limit exceeded")
      const owned = changes.filter(
        (c) => record(c.metadata).razorpay_refund_import === existing!.id
      )
      if (owned.length > 1)
        throw new Error("Duplicate refund accounting changes")
      const change =
        owned[0] ||
        (await orders.createOrderChange({
          order_id: orderId,
          change_type: OrderChangeType.CREDIT_LINE,
          metadata: { razorpay_refund_import: existing.id },
        }))
      if (change.status !== "pending")
        throw new Error("Refund credit change requires review")
      const actions = change.actions || []
      if (
        actions.length > 1 ||
        actions.some(
          (a) =>
            a.reference !== reference ||
            a.reference_id !== existing!.id ||
            a.action !== ChangeActionType.CREDIT_LINE_ADD ||
            paise(record(a).amount) !== credit
        )
      )
        throw new Error("Refund credit action mismatch")
      if (!actions.length)
        await orders.addOrderAction([
          {
            order_change_id: change.id,
            order_id: orderId,
            version: change.version,
            action: ChangeActionType.CREDIT_LINE_ADD,
            reference,
            reference_id: existing.id,
            amount: major(Number(credit)),
          },
        ])
      await orders.confirmOrderChange(change.id)
    }
    const notificationChanges = await orders.listOrderChanges(
      { order_id: orderId },
      { ...fresh, take: 501 }
    )
    if (notificationChanges.length > 500)
      throw new Error("Order change review limit exceeded")
    const notification = notificationChanges.filter(
      (c) => record(c.metadata).razorpay_refund_import === existing!.id
    )
    if (notification.length !== 1)
      throw new Error("Unique refund notification checkpoint required")
    const metadata = record(notification[0].metadata)
    if (metadata.razorpay_refund_event_emitted !== true) {
      // Enqueue only after every accounting stage commits. Queue delivery is
      // at least once; consumers can deduplicate by the stable refund identity.
      await scope.resolve<IEventBusModuleService>(Modules.EVENT_BUS).emit({
        name: PaymentEvents.REFUNDED,
        data: {
          id: nativeId,
          refund_id: existing.id,
          gateway_refund_id: event.refund_id,
        },
      })
      await orders.updateOrderChanges({
        id: notification[0].id,
        metadata: { ...metadata, razorpay_refund_event_emitted: true },
      })
    }
    return {
      status: "imported",
      refund_id: existing.id,
      gateway_refund_id: event.refund_id,
      amount_paise: Number(refund.amount),
    }
  })
}
