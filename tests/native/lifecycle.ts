import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import type { ExecArgs, IPaymentModuleService } from "@medusajs/framework/types"
import {
  Modules,
  ModulesSdkUtils,
  SoftDeletableFilterKey,
} from "@medusajs/framework/utils"
import {
  updatePaymentSessionClientDataWorkflow,
  createOrderWorkflow,
  createOrderPaymentCollectionWorkflow,
  capturePaymentWorkflow,
  refundPaymentWorkflow,
} from "@medusajs/medusa/core-flows"
import { importRazorpayRefund } from "@abhi1693/medusa-payment-razorpay"
export default async function lifecycle({ container }: ExecArgs) {
  const url = new URL(process.env.DATABASE_URL!)
  assert.ok(url.pathname.startsWith("/razorpay_isolated_"))
  assert.equal(process.env.NODE_ENV, "test")
  const service = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const observationDb = ModulesSdkUtils.createPgConnection({
    clientUrl: process.env.DATABASE_URL!,
    pool: { min: 0, max: 1 },
  })
  let nativePaymentId: string | undefined
  const realFetch = globalThis.fetch
  let order: any
  let payment: any
  let refunds = new Map<string, any>()
  let refundPosts = 0
  let capturePosts = 0
  let loseResponse = false
  globalThis.fetch = async (input: any, init: any) => {
    const path = String(input).replace("https://api.razorpay.com/v1/", "")
    const body = init?.body ? JSON.parse(init.body) : undefined
    let result: any
    if (path === "orders" && body) {
      order = {
        id: "order_native",
        amount: body.amount,
        currency: body.currency,
        status: "created",
        notes: body.notes,
      }
      result = order
    } else if (path === "orders/order_native") result = order
    else if (path === "orders/order_native/payments")
      result = { items: payment ? [payment] : [] }
    else if (path === "payments/pay_native") result = payment
    else if (path.includes("/refunds?"))
      result = { items: [...refunds.values()] }
    else if (path.startsWith("refunds/"))
      result = [...refunds.values()].find((r) => r.id === path.slice(8))
    else if (path.endsWith("/capture")) {
      capturePosts++
      throw Error("Auto-capture must not POST capture")
    } else if (path === "payments/pay_native/refund") {
      refundPosts++
      assert.ok(nativePaymentId)
      const reserved = await observationDb.raw(
        "SELECT count(*)::int AS count FROM refund WHERE payment_id = ? AND deleted_at IS NULL",
        [nativePaymentId]
      )
      assert.ok(
        reserved.rows[0].count > 0,
        "Native refund reservation must be committed before the provider request"
      )
      if (process.env.TEST_EXPECT_REFUND_GUARD === "true") {
        const locked = await observationDb.raw(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"
        )
        assert.ok(
          locked.rows[0].count > 0,
          "Configured provider refund must hold its coordination lock"
        )
      }
      const key = init.headers["X-Refund-Idempotency"]
      assert.match(key, /^[a-f0-9]{64}$/)
      if (!refunds.has(key)) {
        refunds.set(key, {
          id: "rfnd_native" + refunds.size,
          amount: body.amount,
          currency: "INR",
          status: "processed",
          payment_id: payment.id,
          notes: body.notes,
        })
        payment.amount_refunded = (payment.amount_refunded || 0) + body.amount
      }
      result = refunds.get(key)
      if (loseResponse) {
        loseResponse = false
        throw Error("Simulated lost gateway response")
      }
    } else throw Error("Unexpected gateway request " + path)
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  try {
    const region = await container.resolve(Modules.REGION).createRegions({
      name: "Isolated INR refund fixture",
      currency_code: "inr",
      countries: ["in"],
      automatic_taxes: false,
    })
    const channel = await container
      .resolve(Modules.SALES_CHANNEL)
      .createSalesChannels({ name: "Isolated refund channel" })
    const { result: orderFixture } = await createOrderWorkflow(container).run({
      input: {
        region_id: region.id,
        sales_channel_id: channel.id,
        currency_code: "inr",
        items: [
          { title: "Isolated refund fixture", quantity: 1, unit_price: 123.45 },
        ],
      },
    })
    const { result: collections } = await createOrderPaymentCollectionWorkflow(
      container
    ).run({ input: { order_id: orderFixture.id, amount: 123.45 } })
    const collection = collections[0]
    const session = await service.createPaymentSession(collection.id, {
      provider_id: "pp_razorpay_razorpay",
      amount: 123.45,
      currency_code: "inr",
      data: {},
    })
    assert.equal(session.data.amount, 12345)
    assert.equal(order.notes.medusa_payment_session_id, session.id)
    payment = {
      id: "pay_native",
      amount: 12345,
      currency: "INR",
      order_id: order.id,
      status: "captured",
    }
    order.status = "paid"
    const signature = createHmac("sha256", "fixture_secret")
      .update("order_native|pay_native")
      .digest("hex")
    await updatePaymentSessionClientDataWorkflow(container).run({
      input: {
        payment_collection_id: collection.id,
        payment_session_id: session.id,
        client_data: {
          order_id: "order_foreign",
          session_id: "payses_foreign",
          amount: 1,
          currency: "USD",
          payment_id: "pay_foreign",
          razorpay_order_id: order.id,
          razorpay_payment_id: payment.id,
          razorpay_signature: signature,
        },
      },
    })
    const updated = await service.retrievePaymentSession(session.id)
    assert.equal(updated.data.order_id, order.id)
    assert.equal(updated.data.session_id, session.id)
    assert.equal(updated.data.amount, 12345)
    assert.equal(updated.data.currency, "INR")
    assert.equal(updated.data.payment_id, payment.id)
    const native = await service.authorizePaymentSession(session.id, {})
    assert.ok(native)
    nativePaymentId = native.id
    assert.equal(native.data.payment_id, payment.id)
    const replay = await service.authorizePaymentSession(session.id, {})
    assert.equal(replay!.id, native.id)
    await capturePaymentWorkflow(container).run({
      input: { payment_id: native.id },
    })
    let saved = await service.retrievePayment(native.id, {
      relations: ["captures", "refunds"],
    })
    assert.equal(saved.captures.length, 1)
    assert.equal(capturePosts, 0)
    await refundPaymentWorkflow(container).run({
      input: {
        payment_id: native.id,
        amount: 1,
        idempotency_key: "native_refund_1",
      },
    })
    await service.refundPayment({
      payment_id: native.id,
      amount: 1,
      idempotency_key: "native_refund_1",
    })
    assert.equal(refunds.size, 1)
    assert.equal(refundPosts, 1)
    loseResponse = true
    await assert.rejects(
      service.refundPayment({
        payment_id: native.id,
        amount: 2,
        idempotency_key: "native_refund_lost",
      })
    )
    const activeAttempts = await service.listRefunds({ payment_id: native.id })
    const allAttempts = await service.listRefunds(
      { payment_id: native.id },
      { filters: { [SoftDeletableFilterKey]: { withDeleted: true } } }
    )
    assert.equal(activeAttempts.length, 1)
    assert.equal(
      allAttempts.length,
      2,
      "Uncertain soft-deleted refund must remain visible to completion review"
    )
    await assert.rejects(
      service.refundPayment({
        payment_id: native.id,
        amount: 2,
        idempotency_key: "native_refund_lost",
      }),
      /already processed/
    )
    await importRazorpayRefund(
      container,
      { payment_id: payment.id, refund_id: [...refunds.values()][1].id },
      {
        mode: "test",
        key_id: "rzp_test_fixture",
        key_secret: "fixture_secret",
        coordinate: async (_sessions, work) => work(),
      }
    )
    assert.equal(
      refundPosts,
      2,
      "Lost-response recovery must GET existing funds rather than POST again"
    )
    assert.equal(refunds.size, 2)
    assert.equal(payment.amount_refunded, 300)
    saved = await service.retrievePayment(native.id, {
      relations: ["captures", "refunds"],
    })
    assert.equal(saved.refunds.length, 2)
    await assert.rejects(
      service.refundPayment({
        payment_id: native.id,
        amount: 999,
        idempotency_key: "too_much",
      })
    )
    const raw = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: payment.id } } },
      })
    )
    const webhook = {
      provider: "razorpay_razorpay",
      payload: {
        rawData: raw,
        data: {},
        headers: {
          "x-razorpay-signature": createHmac("sha256", "fixture_webhook")
            .update(raw)
            .digest("hex"),
          "x-razorpay-event-id": "native_event",
        },
      },
    }
    assert.deepEqual(
      await service.getWebhookActionAndData(webhook),
      await service.getWebhookActionAndData(webhook)
    )
    const competing = await Promise.allSettled([
      service.refundPayment({
        payment_id: native.id,
        amount: 100,
        idempotency_key: "concurrent_a",
      }),
      service.refundPayment({
        payment_id: native.id,
        amount: 100,
        idempotency_key: "concurrent_b",
      }),
    ])
    assert.equal(
      competing.filter((r) => r.status === "fulfilled").length,
      1,
      "Only one competing refund may reserve the captured balance"
    )
    assert.equal(competing.filter((r) => r.status === "rejected").length, 1)
    assert.equal(payment.amount_refunded, 10300)
    await service.refundPayment({
      payment_id: native.id,
      amount: 20.45,
      idempotency_key: "remaining_full_balance",
    })
    assert.equal(payment.amount_refunded, 12345)
    saved = await service.retrievePayment(native.id, { relations: ["refunds"] })
    assert.equal(saved.refunds.length, 4)
    const postsAtCap = refundPosts
    await assert.rejects(
      service.refundPayment({
        payment_id: native.id,
        amount: 0.01,
        idempotency_key: "past_full_balance",
      })
    )
    assert.equal(
      refundPosts,
      postsAtCap,
      "Unsupported sub-rupee refund must never reach the gateway"
    )
    console.info(
      "PASS native PostgreSQL: provider registration, session client isolation, authorization replay, one auto-capture, keyed refund replay, lost-response retry, concurrent cumulative caps, full remaining balance and webhook replay mapping"
    )
  } finally {
    globalThis.fetch = realFetch
    await observationDb.destroy()
  }
}
