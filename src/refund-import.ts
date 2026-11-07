import { operatorRecoveryExecution } from "./operator-recovery-context"
import { OperatorRefundRecoveryRequiredError } from "./operator-recovery-required-error"
import type { FinancialCoordinator } from "./financial-coordination"
import { inrMinorUnits, inrMajorUnits as major } from "./amounts"
import { createLogger } from "./logger"
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
  OrderChangeType,
  ChangeActionType,
  PaymentEvents,
  MedusaError,
  SoftDeletableFilterKey,
} from "@medusajs/framework/utils"
import {
  gatewayReader,
  reconcileRazorpayPayment,
  type ReconciliationOptions,
} from "./reconciliation"
import { record, records } from "./records"
import { PendingRefundRecoveryError } from "./refund-recovery-error"
import { observedRefundExecution } from "./refund-import-context"

export type RefundImportOptions = ReconciliationOptions & {
  coordinate: FinancialCoordinator
}
const reference = "razorpay_refund"
// Public FindConfig ORM options force current relations after another worker commits.
const fresh = { options: { refresh: true } }
const paise = (value: unknown) => inrMinorUnits(value, { allowNegative: true })
function refundKeyHash(order: string, key: string) {
  return createHash("sha256")
    .update(order + ":" + key)
    .digest("hex")
}
// Internal worker API. The caller must authenticate the webhook (or be an
// authorized operator). Every remote entity is independently fetched/verified.
async function importRefund(
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
    // Index each independently verified gateway detail once per import. This
    // avoids repeated network reads for every existing native refund and rejects
    // duplicate operation hashes rather than silently adopting one.
    let operations: Map<string, Record<string, unknown>[]> | undefined
    const refundsForOperation = async (hash: string) => {
      if (!operations) {
        const index = new Map<string, Record<string, unknown>[]>()
        for (const listed of report.gateway_refunds) {
          const detail =
            listed.id === refund.id ? refund : await get("refunds/" + listed.id)
          if (
            detail.id !== listed.id ||
            detail.payment_id !== event.payment_id ||
            detail.currency !== "INR" ||
            detail.amount !== listed.amount_paise ||
            detail.status !== listed.status
          )
            throw new Error(
              "Gateway refund detail changed during import; retry observation"
            )
          const operation = record(detail.notes).medusa_refund_key
          if (typeof operation === "string")
            index.set(operation, [...(index.get(operation) || []), detail])
        }
        operations = index
      }
      return operations.get(hash) || []
    }
    const native = await payments.retrievePayment(nativeId, {
      ...fresh,
      relations: ["refunds"],
    })
    const refunds = native.refunds || []
    const attempts = await payments.listRefunds(
      { payment_id: nativeId },
      {
        ...fresh,
        filters: { [SoftDeletableFilterKey]: { withDeleted: true } },
        take: 501,
      }
    )
    if (attempts.length > 500)
      throw new Error("Native refund attempt review limit exceeded")
    // Native-created gateway refunds carry an opaque operation hash. This
    // separates them from Dashboard refunds even if the webhook races commit.
    const nativeKey = record(refund.notes).medusa_refund_key
    let originHash: string | undefined
    let originRefundId: string | undefined
    const originDetails: {
      created_by?: string
      note?: string
      refund_reason_id?: string
    } = {}
    if (nativeKey !== undefined) {
      if (
        typeof nativeKey !== "string" ||
        (await refundsForOperation(nativeKey)).length !== 1
      )
        throw new Error("Ambiguous native gateway refund operation")
      const matches = attempts.filter(
        (r) =>
          refundKeyHash(
            String(report.gateway_order_id),
            String(record(r).idempotency_key || r.id)
          ) === nativeKey
      )
      if (
        matches.length !== 1 ||
        paise(matches[0].amount) !== refund.amount ||
        record(refund.notes).medusa_payment_session_id !== session
      )
        throw new Error(
          "Native refund operation has not committed or mismatches gateway"
        )
      const match = matches[0]
      if (record(match).status === "succeeded") {
        if (refund.status !== "processed")
          throw new Error(
            "Accepted native refund is not processed at gateway; accounting review required"
          )
        return {
          status: "native",
          refund_id: match.id,
          gateway_status: String(refund.status),
        }
      }
      if (record(match).status === "pending")
        throw new OperatorRefundRecoveryRequiredError()
      if (record(match).status !== "failed" || !record(match).deleted_at)
        throw new Error("Native refund attempt is not safely recoverable")
      // The failed native attempt remains an audit record. A processed gateway
      // request receives one canonical successful native import, GET-only.
      originHash = String(nativeKey)
      originRefundId = match.id
      for (const field of ["created_by", "note", "refund_reason_id"] as const) {
        const value = record(match)[field]
        if (typeof value === "string") originDetails[field] = value
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
    let existing = attempts.find((r) => record(r).idempotency_key === key)
    const resumingExisting = !!existing
    const control = operatorRecoveryExecution.getStore()
    const controlled =
      control?.session_id === session &&
      control.gateway_refund_id === event.refund_id
    if (existing && record(existing).status !== "succeeded" && !controlled)
      throw new OperatorRefundRecoveryRequiredError()
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
        const matches = await refundsForOperation(
          refundKeyHash(String(report.gateway_order_id), k)
        )
        if (!matches.length)
          throw new Error(
            "Native refund lacks a verified gateway operation association"
          )
        if (
          matches.length !== 1 ||
          matches[0].amount !== paise(r.amount) ||
          matches[0].status !== "processed" ||
          record(matches[0].notes).medusa_payment_session_id !== session
        )
          throw new Error("Native gateway refund association mismatch")
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
          "metadata",
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
    if (order.currency_code !== "inr")
      throw new Error("Order cannot accept refund import")
    const summary = record(order.summary)
    const pendingValue =
      summary.raw_pending_difference ?? summary.pending_difference
    if (pendingValue === undefined || pendingValue === null)
      throw new Error("Native order accounting summary is incomplete")
    const pending = paise(pendingValue)
    if (!existing && pending > 0)
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
    // Match native refund-credit semantics: a previously granted credit is
    // paid out first, and only the excess receives a new credit line. A canceled
    // order can accept an already-owed payout, never a new order credit.
    if (order.status === "canceled" && Number(credit) > 0)
      throw new Error("Canceled order requires an existing refund credit")
    if (existing) {
      const stored = record(record(record(existing).metadata).razorpay_import)
      if (
        paise(existing.amount) !== refund.amount ||
        stored.gateway_refund_id !== event.refund_id ||
        stored.gateway_payment_id !== event.payment_id ||
        stored.order_id !== orderId ||
        stored.amount_paise !== refund.amount ||
        stored.original_native_refund_id !== originRefundId
      )
        throw new Error("Native refund import intent mismatch")
    }
    const resumePending = !!existing && record(existing).status === "pending"
    if (!existing || resumePending || record(existing).status === "failed") {
      try {
        await observedRefundExecution.run(
          { session, key, origin_hash: originHash },
          () =>
            payments.refundPayment({
              payment_id: nativeId,
              amount: major(Number(refund.amount)),
              idempotency_key: key,
              ...originDetails,
              note: originDetails.note || "Verified Razorpay processed refund",
              metadata: {
                razorpay_import: {
                  gateway_refund_id: event.refund_id,
                  gateway_payment_id: event.payment_id,
                  order_id: orderId,
                  amount_paise: refund.amount,
                  credit_paise: credit,
                  original_native_refund_id: originRefundId,
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
    if (resumingExisting && !controlled) {
      const priorTransactions = await orders.listOrderTransactions({
        order_id: orderId,
        reference: "refund",
        reference_id: existing.id,
      })
      const priorCredits = records(order.credit_lines).filter(
        (line) =>
          line.reference === reference && line.reference_id === existing.id
      )
      if (
        priorTransactions.length !== 1 ||
        paise(priorTransactions[0].amount) !== -Number(refund.amount) ||
        priorCredits.length !== (Number(credit) > 0 ? 1 : 0) ||
        (priorCredits[0] && paise(priorCredits[0].amount) !== credit)
      )
        throw new OperatorRefundRecoveryRequiredError()
    }
    // Controlled recovery rechecks each committed stage through its native reference.
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
    let metadata: Record<string, unknown>
    let checkpoint: (metadata: Record<string, unknown>) => Promise<unknown>
    if (Number(credit) > 0) {
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
      metadata = record(notification[0].metadata)
      checkpoint = (value) =>
        orders.updateOrderChanges({ id: notification[0].id, metadata: value })
    } else {
      // A payout against an existing credit must not create a zero-value
      // financial change solely as a notification marker. Native order metadata
      // checkpoints enqueue only; it is never financial authority.
      const current = await readOrder()
      const root = record(current.metadata)
      const notifications = record(root.razorpay_refund_notifications)
      metadata = {
        razorpay_refund_event_emitted: notifications[existing.id] === true,
      }
      checkpoint = () =>
        orders.updateOrders([
          {
            id: orderId,
            metadata: {
              ...root,
              razorpay_refund_notifications: {
                ...notifications,
                [existing!.id]: true,
              },
            },
          },
        ])
    }
    if (metadata.razorpay_refund_event_emitted !== true) {
      await scope.resolve<IEventBusModuleService>(Modules.EVENT_BUS).emit({
        name: PaymentEvents.REFUNDED,
        data: {
          id: nativeId,
          refund_id: existing.id,
          gateway_refund_id: event.refund_id,
        },
        options: { jobId: "razorpay-import-refund-" + existing.id },
      })
      await checkpoint({ ...metadata, razorpay_refund_event_emitted: true })
    }
    return {
      status: "imported",
      refund_id: existing.id,
      gateway_refund_id: event.refund_id,
      amount_paise: Number(refund.amount),
    }
  })
}

export async function importRazorpayRefund(
  scope: MedusaContainer,
  event: { refund_id: string; payment_id: string },
  options: RefundImportOptions
) {
  const logger = createLogger({
    sink: options.logger,
    level: options.log_level,
  })
  logger.debug("Razorpay refund import started")
  try {
    const result = await importRefund(scope, event, options)
    logger.info("Razorpay refund import completed")
    return result
  } catch (error) {
    logger.warning("Razorpay refund import failed")
    throw error
  }
}
