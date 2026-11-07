import { RazorpayGateway, GatewayRequestError } from "./gateway"
import { createLogger, type LogLevel, type LoggerSink } from "./logger"
import type {
  BigNumberInput,
  MedusaContainer,
  IPaymentModuleService,
} from "@medusajs/framework/types"
import { BigNumber, MedusaError, Modules } from "@medusajs/framework/utils"
import { record, records } from "./records"
export type ReconciliationOptions = {
  log_level?: LogLevel
  logger?: LoggerSink
  mode: "test"
  key_id: string
  key_secret: string
  provider_id?: string
}

function paise(value: unknown) {
  const text = new BigNumber(value as BigNumberInput).bigNumber!.toFixed()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Invalid INR amount")
  const [whole, fraction = ""] = text.split(".")
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("INR amount exceeds supported range")
  return Number(amount)
}
function minor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Invalid gateway INR amount")
  return Number(value)
}
function sum(values: number[]) {
  const total = values.reduce((a, n) => a + BigInt(n), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Total exceeds supported range")
  return Number(total)
}
export type GatewayReader = (path: string) => Promise<Record<string, unknown>>
export function gatewayReader(options: ReconciliationOptions): GatewayReader {
  const key = options.key_id,
    secret = options.key_secret
  if (
    options.mode !== "test" ||
    !/^rzp_test_[A-Za-z0-9]+$/.test(key || "") ||
    typeof secret !== "string" ||
    !secret.trim()
  )
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Test gateway configuration is required"
    )
  const client = new RazorpayGateway({
    key_id: key,
    key_secret: secret,
    logger: options.logger,
    log_level: options.log_level,
  })
  const deadline = Date.now() + 30000
  // Expose GET only; retain a total deadline across reconciliation reads.
  return async (path: string) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      throw new Error("Gateway reconciliation timed out; no records changed")
    try {
      return record(await client.get(path, Math.min(15000, remaining)))
    } catch (error) {
      if (
        error instanceof GatewayRequestError &&
        error.kind === "http" &&
        error.status !== undefined
      )
        throw new Error(
          `Gateway reconciliation unavailable (HTTP ${error.status}); no records changed`,
          { cause: error }
        )
      throw new Error(
        "Gateway reconciliation transport unavailable; no records changed",
        { cause: error }
      )
    }
  }
}
// Report only: never update financial records, retry a refund or issue a gateway POST.
async function reconcilePayment(
  scope: MedusaContainer,
  id: string,
  options: ReconciliationOptions
) {
  if (!/^pay_[A-Za-z0-9]+$/.test(id))
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment not found")
  const native = await scope
    .resolve<IPaymentModuleService>(Modules.PAYMENT)
    .retrievePayment(id, {
      relations: ["captures", "refunds", "payment_session"],
      options: { refresh: true },
    })
  const data = record(native.data)
  if (
    native.provider_id !== (options.provider_id || "pp_razorpay_razorpay") ||
    record(record(native).payment_session).id !== data.session_id ||
    native.currency_code !== "inr" ||
    data.currency !== "INR" ||
    !/^pay_[A-Za-z0-9]+$/.test(String(data.payment_id)) ||
    !/^order_[A-Za-z0-9]+$/.test(String(data.order_id)) ||
    !/^payses_[A-Za-z0-9]+$/.test(String(data.session_id)) ||
    paise(native.amount) !== data.amount
  )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Payment is not a supported bound Razorpay payment"
    )
  const get = gatewayReader(options)
  const gateway = await get("payments/" + data.payment_id)
  const order = await get("orders/" + data.order_id)
  if (
    gateway.id !== data.payment_id ||
    gateway.order_id !== data.order_id ||
    gateway.amount !== data.amount ||
    gateway.currency !== "INR" ||
    order.id !== data.order_id ||
    order.amount !== data.amount ||
    order.currency !== "INR" ||
    record(order.notes).medusa_payment_session_id !== data.session_id
  )
    throw new Error(
      "Gateway payment/order binding mismatch; no records changed"
    )
  const refunds: Record<string, unknown>[] = [],
    seen = new Set<string>()
  let complete = false
  for (let skip = 0; skip < 500; skip += 100) {
    const page = await get(
      "payments/" + data.payment_id + "/refunds?count=100&skip=" + skip
    )
    if (!Array.isArray(page.items))
      throw new Error("Invalid gateway refund listing")
    const items = records(page.items)
    for (const refund of items) {
      const refundId = String(refund.id)
      if (
        !/^rfnd_[A-Za-z0-9]+$/.test(refundId) ||
        seen.has(refundId) ||
        refund.payment_id !== data.payment_id ||
        refund.currency !== "INR" ||
        !["pending", "processed", "failed"].includes(String(refund.status)) ||
        minor(refund.amount) <= 0 ||
        Number(refund.amount) > Number(data.amount)
      )
        throw new Error(
          "Gateway refund listing changed or has invalid associations; reconcile again"
        )
      seen.add(refundId)
      refunds.push({
        id: refundId,
        amount_paise: refund.amount,
        status: refund.status,
        // Speed changes are informational and never advance refund accounting.
        speed_requested:
          typeof refund.speed_requested === "string"
            ? refund.speed_requested
            : null,
        speed_processed:
          typeof refund.speed_processed === "string"
            ? refund.speed_processed
            : null,
      })
    }
    if (items.length < 100) {
      complete = true
      break
    }
  }
  const nativeRefunds = (native.refunds || []).map((r) => ({
    id: r.id,
    amount_paise: paise(r.amount),
    status: typeof record(r).status === "string" ? record(r).status : "unknown",
  }))
  const accepted = sum(
    refunds
      .filter((r) => r.status !== "failed")
      .map((r) => Number(r.amount_paise))
  )
  const nativeTotal = sum(nativeRefunds.map((r) => r.amount_paise))
  const reported = minor(gateway.amount_refunded)
  const latestRefundId =
    typeof data.last_refund_id === "string" &&
    /^rfnd_[A-Za-z0-9]+$/.test(data.last_refund_id)
      ? data.last_refund_id
      : null
  const discrepancies: string[] = []
  if (complete && latestRefundId && !seen.has(latestRefundId))
    discrepancies.push(
      "Latest native gateway refund ID is absent from this gateway payment"
    )
  if (accepted > Number(data.amount) || reported > Number(data.amount))
    discrepancies.push(
      "Gateway refunded amount exceeds the bound payment amount"
    )
  if (!complete)
    discrepancies.push("Gateway refund list exceeds the report limit")
  if (complete && accepted !== nativeTotal)
    discrepancies.push(
      "Native refund total differs from gateway pending/processed refund total"
    )
  if (complete && reported !== accepted)
    discrepancies.push(
      "Gateway payment refund total differs from listed accepted refunds"
    )
  if (refunds.some((r) => r.status === "failed"))
    discrepancies.push(
      "Gateway contains failed refunds; inspect their native association manually"
    )
  if (nativeRefunds.some((r) => r.status !== "succeeded"))
    discrepancies.push("Native refund processing is not settled")
  return {
    payment_id: native.id,
    gateway_payment_id: gateway.id,
    gateway_order_id: order.id,
    currency: "INR",
    amount_paise: data.amount,
    gateway_status: gateway.status,
    native_captured_paise: sum(
      (native.captures || []).map((c) => paise(c.amount))
    ),
    native_refunded_paise: nativeTotal,
    gateway_reported_refunded_paise: reported,
    gateway_accepted_refunded_paise: accepted,
    native_refunds: nativeRefunds,
    gateway_refunds: refunds,
    latest_gateway_refund_id: latestRefundId,
    complete,
    discrepancies,
    observed_at: new Date().toISOString(),
    limitations: [
      "Read-only observations are not an atomic gateway/native snapshot",
      "Matching totals do not prove individual refund identity or settlement",
      "Only the latest native gateway refund ID is retained; older refunds require manual association",
      "No financial repair or monetary retry was performed",
    ],
  }
}

export async function reconcileRazorpayPayment(
  scope: MedusaContainer,
  id: string,
  options: ReconciliationOptions
) {
  const logger = createLogger({
    sink: options.logger,
    level: options.log_level,
  })
  logger.debug("Razorpay payment reconciliation started")
  try {
    const result = await reconcilePayment(scope, id, options)
    if (result.discrepancies.length)
      logger.warning("Razorpay payment reconciliation requires review")
    else logger.info("Razorpay payment reconciliation completed")
    return result
  } catch (error) {
    logger.warning("Razorpay payment reconciliation failed")
    throw error
  }
}
export type RazorpayReconciliationReport = Awaited<
  ReturnType<typeof reconcileRazorpayPayment>
>
