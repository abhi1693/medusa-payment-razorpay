import { record } from "../records"
import { resolve } from "node:path"
import type { ExecArgs } from "@medusajs/framework/types"
import { dynamicImport } from "@medusajs/framework/utils"
import {
  assessRazorpayRefundRecovery,
  recoverRazorpayRefund,
} from "../operator-recovery"
import type { RefundRecoveryConfigurationFactory } from "../operator-configuration"
export type RefundRecoveryCommand = {
  action: "assess" | "apply"
  config: string
  native_payment_id: string
  gateway_refund_id: string
  fingerprint?: string
}
export function parseRefundRecoveryCommand(
  args: string[]
): RefundRecoveryCommand {
  const [action, config, native, refund, fingerprint] = args
  if (action !== "assess" && action !== "apply")
    throw new Error("Use assess or apply")
  if (args.length !== (action === "assess" ? 4 : 5))
    throw new Error(
      "Use ACTION CONFIG NATIVE_PAYMENT GATEWAY_REFUND [REVIEWED_FINGERPRINT]"
    )
  if (
    !config ||
    config.startsWith("-") ||
    !native ||
    !refund ||
    native.trim() !== native ||
    refund.trim() !== refund ||
    !/^pay_[A-Za-z0-9]+$/.test(native) ||
    !/^rfnd_[A-Za-z0-9]+$/.test(refund)
  )
    throw new Error("Config, native payment and gateway refund are required")
  if (
    action === "apply" &&
    (!fingerprint ||
      fingerprint.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(fingerprint))
  )
    throw new Error("Apply requires the reviewed assessment fingerprint")
  return {
    action,
    config,
    native_payment_id: native,
    gateway_refund_id: refund,
    fingerprint,
  }
}
export default async function refundRecoveryCommand({
  container,
  args,
}: ExecArgs): Promise<void> {
  const command = parseRefundRecoveryCommand(args)
  // This is trusted local operator code, with the same privileges as medusa exec.
  const module = record(
    await dynamicImport(resolve(process.cwd(), command.config))
  )
  const factory = module.default
  if (!isConfigurationFactory(factory))
    throw new Error(
      "Recovery config must default-export a configuration factory"
    )
  const configuration = await factory(container)
  if (typeof configuration?.options?.coordinate !== "function")
    throw new Error("Recovery configuration requires distributed coordination")
  const target = {
    native_payment_id: command.native_payment_id,
    gateway_refund_id: command.gateway_refund_id,
  }
  if (
    command.action === "apply" &&
    typeof configuration.control?.withQuiescence !== "function"
  )
    throw new Error("Apply requires application-enforced maintenance control")
  const result =
    command.action === "assess"
      ? await assessRazorpayRefundRecovery(
          container,
          target,
          configuration.options
        )
      : await recoverRazorpayRefund(container, target, configuration.options, {
          fingerprint: command.fingerprint!,
          control: configuration.control!,
        })
  process.stdout.write(
    JSON.stringify({ type: "razorpay_refund_recovery", ...result }) + "\n"
  )
  if (result.status === "quarantined")
    throw new Error(
      "Refund recovery quarantined; inspect the assessment before retrying"
    )
}

function isConfigurationFactory(
  value: unknown
): value is RefundRecoveryConfigurationFactory {
  return typeof value === "function"
}
