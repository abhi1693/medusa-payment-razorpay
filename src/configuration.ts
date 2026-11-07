import { MedusaError } from "@medusajs/framework/utils"

export type RazorpayMode = "test" | "live"
export type RazorpayCredentials = {
  mode: RazorpayMode
  key_id: string
  key_secret: string
}

/** Require an explicit account mode; never infer live access from a key. */
export function validateRazorpayCredentials<
  T extends {
    mode?: unknown
    key_id?: unknown
    key_secret?: unknown
  },
>(options: T): asserts options is T & RazorpayCredentials {
  if (options.mode !== "test" && options.mode !== "live")
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay mode must be explicitly set to test or live"
    )
  if (
    typeof options.key_id !== "string" ||
    options.key_id !== options.key_id.trim() ||
    !new RegExp(`^rzp_${options.mode}_[A-Za-z0-9]+$`).test(options.key_id)
  )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay key ID must match the configured mode"
    )
  if (typeof options.key_secret !== "string" || !options.key_secret.trim())
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Razorpay API secret must be configured privately"
    )
}
