import type {
  IPaymentModuleService,
  ILockingModule,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createRazorpayCoordinator } from "./financial-coordination"
import { record } from "./records"
import type { RefundImportOptions } from "./refund-import"
import type { ReconciliationOptions } from "./reconciliation"
import type { RefundRecoveryControl } from "./operator-recovery"
export type RefundRecoveryConfiguration = {
  options: RefundImportOptions
  control?: RefundRecoveryControl
}
export type RefundRecoveryConfigurationFactory = (
  scope: MedusaContainer
) => RefundRecoveryConfiguration | Promise<RefundRecoveryConfiguration>
/** Select an explicitly configured durable native locking provider, never a default guess. */
export function createRazorpayRecoveryOptions(
  scope: MedusaContainer,
  options: ReconciliationOptions,
  lockingProvider: string
): RefundImportOptions {
  if (!lockingProvider || lockingProvider.trim() !== lockingProvider)
    throw new Error("An explicit durable locking provider is required")
  const payments = scope.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const locking = scope.resolve<ILockingModule>(Modules.LOCKING)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  return {
    ...options,
    coordinate: createRazorpayCoordinator({
      resolve: async (ids) => {
        const sessions = await payments.listPaymentSessions(
          { id: ids },
          { take: ids.length + 1, options: { refresh: true } }
        )
        const associations = []
        for (const session of sessions) {
          const collection = record(session).payment_collection_id
          if (typeof collection !== "string")
            throw new Error("Native session collection required")
          const { data } = await query.graph({
            entity: "order_payment_collection",
            fields: ["order.id"],
            filters: { payment_collection_id: collection },
          })
          if (data.length > 1)
            throw new Error("Ambiguous session order association")
          const order = data.length ? record(record(data[0]).order).id : null
          if (order !== null && typeof order !== "string")
            throw new Error("Native order association required")
          associations.push({ session_id: session.id, order_id: order })
        }
        return associations
      },
      execute: (keys, work) =>
        locking.execute(keys, work, { provider: lockingProvider }),
    }),
  }
}
