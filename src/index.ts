import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import RazorpayProvider from "./service"
export { RazorpayProvider }
export type { Options } from "./service"
export default ModuleProvider(Modules.PAYMENT, { services: [RazorpayProvider] })

export { reconcileRazorpayPayment, gatewayReader } from "./reconciliation"
export type {
  ReconciliationOptions,
  RazorpayReconciliationReport,
} from "./reconciliation"
export { signedRefundEvent, observeRazorpayRefund } from "./refund-observation"
export type { RefundObservationDependencies } from "./refund-observation"
export {
  verify as verifyRazorpayWebhook,
  verifyRazorpayCheckout,
} from "./security"

export { importRazorpayRefund } from "./refund-import"
export type { RefundImportOptions } from "./refund-import"

export {
  reconcileRazorpayRefund,
  RAZORPAY_REFUND_RECOVERY_EVENT,
  REFUND_RECOVERY_DELAY_MS,
} from "./refund-recovery"
export type { RefundRecoveryEvent } from "./refund-recovery"
export { PendingRefundRecoveryError } from "./refund-recovery-error"

export { GatewayRefundPendingError } from "./gateway-refund-pending-error"

export { GatewayRefundReconciliationError } from "./gateway-refund-reconciliation-error"

export { LOG_LEVELS, validateLogLevel } from "./logger"
export type { LogLevel } from "./logger"

export { RazorpayGateway, GatewayRequestError } from "./gateway"

export { createLogger } from "./logger"
export type {
  LoggerSink,
  PluginLogger,
  LoggerOptions,
  LogContext,
} from "./logger"
export type { GatewayOptions, HttpMethod, GatewayFailureKind } from "./gateway"

export type { GatewayReader } from "./reconciliation"
