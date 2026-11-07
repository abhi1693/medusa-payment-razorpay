import { operatorRecoveryExecution } from "./operator-recovery-context"
import { createHash } from "node:crypto"
import type {
  IPaymentModuleService,
  IOrderModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  SoftDeletableFilterKey,
} from "@medusajs/framework/utils"
import { inrMinorUnits } from "./amounts"
import { record, records } from "./records"
import { gatewayReader, reconcileRazorpayPayment } from "./reconciliation"
import { importRazorpayRefund, type RefundImportOptions } from "./refund-import"

export type RefundRecoveryTarget = {
  native_payment_id: string
  gateway_refund_id: string
}
export type RefundRecoveryAssessment = {
  status: "ready" | "complete" | "quarantined"
  reason: string
  mode?: RefundImportOptions["mode"]
  fingerprint?: string
  session_id?: string
  order_id?: string
  gateway_payment_id?: string
  amount_paise?: number
  native_refund_id?: string
}
/** The application must prove old workers/retries are stopped and keep traffic gated. */
export type RefundRecoveryControl = {
  withQuiescence: <T>(
    work: (assertQuiescent: () => Promise<void>) => Promise<T>
  ) => Promise<T>
}
const fresh = { options: { refresh: true } }
const minor = (value: unknown) => inrMinorUnits(value, { allowNegative: true })
const quarantine = (reason: string): RefundRecoveryAssessment => ({
  status: "quarantined",
  reason,
})
function hash(order: unknown, key: unknown) {
  return createHash("sha256")
    .update(String(order) + ":" + String(key))
    .digest("hex")
}
async function inspect(
  scope: MedusaContainer,
  target: RefundRecoveryTarget,
  options: RefundImportOptions
): Promise<RefundRecoveryAssessment> {
  const payments = scope.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const native = await payments.retrievePayment(target.native_payment_id, {
    ...fresh,
    relations: ["captures", "refunds", "payment_session"],
  })
  const data = record(native.data)
  const report = await reconcileRazorpayPayment(scope, native.id, options)
  if (
    !report.complete ||
    report.currency !== "INR" ||
    report.native_captured_paise !== report.amount_paise ||
    !["captured", "refunded"].includes(String(report.gateway_status))
  )
    return quarantine("incomplete_captured_payment")
  const get = gatewayReader(options)
  const refund = await get("refunds/" + target.gateway_refund_id)
  const listed = report.gateway_refunds.find(
    (item) => item.id === target.gateway_refund_id
  )
  if (
    !listed ||
    refund.id !== target.gateway_refund_id ||
    refund.payment_id !== report.gateway_payment_id ||
    refund.currency !== "INR" ||
    refund.amount !== listed.amount_paise ||
    refund.status !== listed.status
  )
    return quarantine("gateway_refund_identity_or_snapshot_mismatch")
  if (refund.status !== "processed")
    return quarantine("gateway_refund_not_processed")
  // Deliberately narrow: no batch adoption or assumptions about other refund histories.
  if (
    report.gateway_refunds.length !== 1 ||
    report.gateway_reported_refunded_paise !== refund.amount ||
    report.gateway_accepted_refunded_paise !== refund.amount
  )
    return quarantine("multiple_or_unbalanced_gateway_refunds")
  const attempts = await payments.listRefunds(
    { payment_id: native.id },
    {
      ...fresh,
      filters: { [SoftDeletableFilterKey]: { withDeleted: true } },
      take: 501,
    }
  )
  if (attempts.length > 500) return quarantine("native_refund_review_limit")
  const key = "razorpay-observed:" + target.gateway_refund_id
  const canonical = attempts.filter(
    (item) => record(item).idempotency_key === key
  )
  const operation = record(refund.notes).medusa_refund_key
  const origins =
    operation === undefined
      ? []
      : attempts.filter(
          (item) =>
            hash(
              report.gateway_order_id,
              record(item).idempotency_key || item.id
            ) === operation
        )
  if (
    canonical.length > 1 ||
    (operation !== undefined &&
      (typeof operation !== "string" ||
        origins.length !== 1 ||
        record(refund.notes).medusa_payment_session_id !== data.session_id))
  )
    return quarantine("ambiguous_native_operation")
  const origin = origins[0]
  if (origin && minor(origin.amount) !== refund.amount)
    return quarantine("original_amount_mismatch")
  if (origin && record(origin).status === "pending")
    return quarantine("original_native_pending_requires_controlled_review")
  // Never replay an original, keyed or unkeyed, or treat native success as proof of credit completion.
  if (
    origin &&
    (record(origin).status !== "failed" || !record(origin).deleted_at)
  )
    return quarantine("original_native_accounting_requires_review")
  const existing = canonical[0]
  if (
    attempts.some((item) => item.id !== origin?.id && item.id !== existing?.id)
  )
    return quarantine("other_native_refund_history_requires_review")
  const live = native.refunds || []
  if (live.some((item) => item.id !== existing?.id))
    return quarantine("unassociated_successful_native_refund")
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: links } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order.id"],
    filters: { payment_collection_id: native.payment_collection_id },
  })
  const orderId = record(record(links[0]).order).id
  if (links.length !== 1 || typeof orderId !== "string")
    return quarantine("unique_order_association_required")
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "currency_code",
      "summary",
      "credit_lines.*",
      "transactions.*",
      "payment_collections.payments.id",
    ],
    filters: { id: orderId },
  })
  const order = record(orders[0])
  const paymentIds = records(order.payment_collections).flatMap((collection) =>
    records(collection.payments).map((payment) => payment.id)
  )
  if (
    orders.length !== 1 ||
    order.id !== orderId ||
    order.currency_code !== "inr" ||
    paymentIds.length !== 1 ||
    paymentIds[0] !== native.id
  )
    return quarantine("single_payment_order_required")
  const summary = record(order.summary)
  const pending = minor(
    summary.raw_pending_difference ?? summary.pending_difference
  )
  const refunded = minor(summary.raw_refunded_total ?? summary.refunded_total)
  const transactions = records(order.transactions).filter(
    (item) => item.reference === "refund"
  )
  if (
    (!existing && transactions.length > 0) ||
    transactions.some((item) => item.reference_id !== existing?.id) ||
    transactions.length > 1 ||
    (transactions[0] &&
      minor(transactions[0].amount) !== -Number(refund.amount))
  )
    return quarantine("unexpected_order_refund_transactions")
  const credits = records(order.credit_lines)
  if (
    credits.some(
      (item) =>
        typeof item.id !== "string" || !item.id || minor(item.amount) < 0
    ) ||
    new Set(credits.map((item) => item.id)).size !== credits.length
  )
    return quarantine("ambiguous_order_credit_lines")
  const intent = record(record(record(existing).metadata).razorpay_import)
  let expectedCredit = Math.max(0, Number(refund.amount) + Math.min(0, pending))
  if (existing) {
    expectedCredit = Number(intent.credit_paise)
    if (
      minor(existing.amount) !== refund.amount ||
      intent.gateway_refund_id !== refund.id ||
      intent.gateway_payment_id !== report.gateway_payment_id ||
      intent.order_id !== orderId ||
      intent.amount_paise !== refund.amount ||
      intent.original_native_refund_id !== origin?.id ||
      !Number.isSafeInteger(expectedCredit) ||
      expectedCredit < 0 ||
      expectedCredit > Number(refund.amount)
    )
      return quarantine("invalid_frozen_import_intent")
  } else if (pending > 0 || refunded !== 0)
    return quarantine("unbalanced_native_order")
  const ownCredits = credits.filter(
    (item) => item.reference === "razorpay_refund"
  )
  if (
    (!existing && ownCredits.length > 0) ||
    ownCredits.some(
      (item) =>
        item.reference_id !== existing?.id ||
        minor(item.amount) !== expectedCredit
    ) ||
    ownCredits.length > (expectedCredit ? 1 : 0)
  )
    return quarantine("unexpected_import_credit")
  if (order.status === "canceled" && expectedCredit > 0)
    return quarantine("canceled_order_requires_existing_credit")
  const changes = await scope
    .resolve<IOrderModuleService>(Modules.ORDER)
    .listOrderChanges(
      { order_id: orderId },
      { ...fresh, relations: ["actions"], take: 501 }
    )
  if (
    changes.length > 500 ||
    changes.some(
      (change) =>
        change.status === "pending" &&
        (!existing ||
          record(change.metadata).razorpay_refund_import !== existing.id)
    )
  )
    return quarantine("unrelated_or_excessive_order_changes")
  const financial = {
    account: {
      mode: options.mode,
      key_id_hash: createHash("sha256").update(options.key_id).digest("hex"),
      provider_id: options.provider_id || "pp_razorpay_razorpay",
    },
    target,
    session_id: data.session_id,
    order_id: orderId,
    gateway: {
      payment: report.gateway_payment_id,
      order: report.gateway_order_id,
      amount: report.amount_paise,
      captured: report.native_captured_paise,
      refund: {
        id: refund.id,
        amount: refund.amount,
        status: refund.status,
        operation,
      },
    },
    attempts: attempts
      .map((item) => ({
        id: item.id,
        key: record(item).idempotency_key,
        amount: minor(item.amount),
        status: record(item).status,
        deleted: !!record(item).deleted_at,
        intent: record(record(item).metadata).razorpay_import,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    order: {
      status: order.status,
      pending,
      refunded,
      transactions: transactions
        .map((item) => ({
          id: item.id,
          reference: item.reference,
          reference_id: item.reference_id,
          amount: minor(item.amount),
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      credits: credits
        .map((item) => ({
          id: item.id,
          reference: item.reference,
          reference_id: item.reference_id,
          amount: minor(item.amount),
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      changes: changes
        .map((change) => ({
          id: change.id,
          status: change.status,
          import_refund: record(change.metadata).razorpay_refund_import,
          actions: records(change.actions)
            .map((action) => ({
              id: action.id,
              action: action.action,
              reference: action.reference,
              reference_id: action.reference_id,
              amount: action.amount,
              details: action.details,
            }))
            .sort((a, b) => String(a.id).localeCompare(String(b.id))),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(financial))
    .digest("hex")
  const complete =
    existing &&
    record(existing).status === "succeeded" &&
    !record(existing).deleted_at &&
    transactions.length === 1 &&
    ownCredits.length === (expectedCredit ? 1 : 0) &&
    refunded === refund.amount &&
    pending <= 0 &&
    report.native_refunded_paise === refund.amount
  return {
    status: complete ? "complete" : "ready",
    reason: complete
      ? "verified_import_accounting"
      : "verified_processed_refund_import",
    fingerprint,
    mode: options.mode,
    session_id: String(data.session_id),
    order_id: orderId,
    gateway_payment_id: String(report.gateway_payment_id),
    amount_paise: Number(refund.amount),
    native_refund_id: existing?.id,
  }
}
async function session(
  scope: MedusaContainer,
  target: RefundRecoveryTarget
): Promise<string> {
  if (
    !/^pay_[A-Za-z0-9]+$/.test(target.native_payment_id) ||
    !/^rfnd_[A-Za-z0-9]+$/.test(target.gateway_refund_id)
  )
    throw new Error("Invalid operator recovery target")
  const native = await scope
    .resolve<IPaymentModuleService>(Modules.PAYMENT)
    .retrievePayment(target.native_payment_id, fresh)
  const id = record(native.data).session_id
  if (typeof id !== "string" || !/^payses_[A-Za-z0-9]+$/.test(id))
    throw new Error("Invalid operator payment session")
  return id
}
export async function assessRazorpayRefundRecovery(
  scope: MedusaContainer,
  target: RefundRecoveryTarget,
  options: RefundImportOptions
): Promise<RefundRecoveryAssessment> {
  try {
    const id = await session(scope, target)
    return await options.coordinate([id], () => inspect(scope, target, options))
  } catch {
    return quarantine("inspection_unavailable_or_invalid")
  }
}
export async function recoverRazorpayRefund(
  scope: MedusaContainer,
  target: RefundRecoveryTarget,
  options: RefundImportOptions,
  request: { fingerprint: string; control: RefundRecoveryControl }
): Promise<RefundRecoveryAssessment & { changes_possible: boolean }> {
  let changesPossible = false
  try {
    return await request.control.withQuiescence(async (assertQuiescent) => {
      await assertQuiescent()
      const id = await session(scope, target)
      return options.coordinate([id], async () => {
        const before = await inspect(scope, target, options)
        if (!before.fingerprint || before.fingerprint !== request.fingerprint)
          return {
            ...quarantine("stale_or_unapproved_assessment"),
            changes_possible: false,
          }
        if (before.status !== "ready")
          return { ...before, changes_possible: false }
        await assertQuiescent()
        changesPossible = true
        await operatorRecoveryExecution.run(
          { session_id: id, gateway_refund_id: target.gateway_refund_id },
          () =>
            importRazorpayRefund(
              scope,
              {
                refund_id: target.gateway_refund_id,
                payment_id: before.gateway_payment_id!,
              },
              {
                ...options,
                coordinate: async (ids, work) => {
                  if (ids.length !== 1 || ids[0] !== id)
                    throw new Error("Recovery association changed")
                  await assertQuiescent()
                  return work()
                },
              }
            )
        )
        await assertQuiescent()
        const after = await inspect(scope, target, options)
        if (after.status !== "complete")
          return {
            ...quarantine("post_recovery_accounting_requires_review"),
            changes_possible: true,
          }
        return { ...after, changes_possible: true }
      })
    })
  } catch {
    return {
      ...quarantine("recovery_interrupted_reassess_before_retry"),
      changes_possible: changesPossible,
    }
  }
}
