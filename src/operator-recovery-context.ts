import { AsyncLocalStorage } from "node:async_hooks"
// Internal capability established only inside the privileged maintenance executor.
export const operatorRecoveryExecution = new AsyncLocalStorage<{
  session_id: string
  gateway_refund_id: string
}>()
