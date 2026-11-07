import { AsyncLocalStorage } from "node:async_hooks"
// Internal execution scope: never serializable or supplied by a Store client.
export const observedRefundExecution = new AsyncLocalStorage<{
  session: string
  key: string
  origin_hash?: string
}>()
