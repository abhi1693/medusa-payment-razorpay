import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const root = process.cwd()
const sourcePackage = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
)
mkdirSync(path.join(root, ".local"), { recursive: true })
const scratch = mkdtempSync(path.join(root, ".local", "package-check-"))
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      { encoding: "utf8" }
    )
  )[0]
  assert.equal(packed.name, "@abhi1693/medusa-payment-razorpay")
  assert.equal(packed.version, sourcePackage.version)
  const files = new Set(packed.files.map((file) => file.path))
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/configuration.js",
    "dist/configuration.d.ts",
    "dist/scripts/refund-recovery.js",
    "dist/scripts/refund-recovery.d.ts",
    "README.md",
    "LICENSE",
    "docs/server-integration.md",
    "docs/operations.md",
  ])
    assert.ok(files.has(required), `Missing package file: ${required}`)
  for (const file of files)
    assert.doesNotMatch(
      file,
      /(^|\/)(?:\.env[^/]*|node_modules|\.git|\.local|tests|src)(?:\/|$)/
    )
  execFileSync("tar", [
    "-xzf",
    path.join(scratch, packed.filename),
    "-C",
    scratch,
  ])
  const packageRoot = path.join(scratch, "package")
  const metadata = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8")
  )
  assert.notEqual(metadata.private, true)
  assert.equal(metadata.publishConfig.access, "public")
  assert.equal(metadata.license, "MIT")
  const consumer = path.join(scratch, "consumer")
  mkdirSync(path.join(consumer, "node_modules", "@abhi1693"), {
    recursive: true,
  })
  symlinkSync(
    packageRoot,
    path.join(consumer, "node_modules", "@abhi1693", "medusa-payment-razorpay"),
    "dir"
  )
  writeFileSync(path.join(consumer, "package.json"), '{"private":true}')
  const require = createRequire(path.join(consumer, "package.json"))
  const api = require("@abhi1693/medusa-payment-razorpay")
  for (const name of [
    "RazorpayProvider",
    "RazorpayGateway",
    "validateRazorpayCredentials",
    "reconcileRazorpayPayment",
    "signedRefundEvent",
    "reconcileRazorpayRefund",
    "RazorpayRefundRejectedError",
    "assessRazorpayRefundRecovery",
    "recoverRazorpayRefund",
    "createRazorpayRecoveryOptions",
  ])
    assert.equal(typeof api[name], "function", `Missing export: ${name}`)
  assert.ok(
    api.default.services.includes(api.RazorpayProvider),
    "Missing native Medusa provider registration"
  )
  for (const mode of ["test", "live"]) {
    const options = {
      mode,
      key_id: `rzp_${mode}_fixture`,
      key_secret: "fixture_secret",
      webhook_secret: "fixture_webhook",
      log_level: "none",
    }
    new api.RazorpayProvider({}, options)
    new api.RazorpayGateway(options)
  }
  const fixture = path.join(consumer, "consumer.ts")
  writeFileSync(
    fixture,
    `import { RazorpayGateway, RazorpayProvider, type Options, type RazorpayMode } from "@abhi1693/medusa-payment-razorpay";
const mode: RazorpayMode = "live";
const options: Options = { mode, key_id: "rzp_live_fixture", key_secret: "fixture_secret", webhook_secret: "fixture_webhook", log_level: "none" };
new RazorpayProvider({}, options); new RazorpayGateway(options);
`
  )
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "Node16",
      "--moduleResolution",
      "Node16",
      fixture,
    ],
    { stdio: "inherit" }
  )
  console.info(
    `Validated ${packed.name}@${packed.version}: ${files.size} files, public runtime exports and TypeScript consumer; no registry publication or network requests.`
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
