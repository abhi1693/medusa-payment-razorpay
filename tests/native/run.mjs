import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
const require = createRequire(import.meta.url)
const { ModulesSdkUtils } = require("@medusajs/framework/utils")
const source = new URL(process.env.DATABASE_URL)
if (
  !["127.0.0.1", "localhost"].includes(source.hostname) ||
  source.pathname !== "/postgres" ||
  process.env.CI !== "true" ||
  process.env.NODE_ENV !== "test"
)
  throw Error("Isolated CI database required")
const db = ModulesSdkUtils.createPgConnection({
  clientUrl: source.href,
  pool: { min: 0, max: 2 },
})
const name = "razorpay_isolated_" + randomBytes(8).toString("hex")
try {
  await db.raw("create database ??", [name])
  source.pathname = "/" + name
  const env = {
    ...process.env,
    DATABASE_URL: source.href,
    JWT_SECRET: "isolated_jwt_" + randomBytes(32).toString("hex"),
    COOKIE_SECRET: "isolated_cookie_" + randomBytes(32).toString("hex"),
  }
  for (const args of [
    ["db:migrate"],
    ["exec", "./owned-razorpay/tests/native/lifecycle.ts"],
  ]) {
    const p = spawnSync(
      process.execPath,
      ["node_modules/@medusajs/cli/cli.js", ...args],
      { env, stdio: "inherit" }
    )
    if (p.status !== 0) throw Error("Native validation failed")
  }
} finally {
  await db.raw("drop database if exists ?? with (force)", [name])
  await db.destroy()
}
