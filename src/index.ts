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
