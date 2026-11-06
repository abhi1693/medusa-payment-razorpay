import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import type { ExecArgs, IPaymentModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { updatePaymentSessionClientDataWorkflow } from "@medusajs/medusa/core-flows"
export default async function lifecycle({ container }: ExecArgs) {
  const url = new URL(process.env.DATABASE_URL!)
  assert.ok(url.pathname.startsWith("/razorpay_isolated_"))
  assert.equal(process.env.NODE_ENV, "test")
  const service = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
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
    else if (path.endsWith("/capture")) {
      capturePosts++
      throw Error("Auto-capture must not POST capture")
    } else if (path === "payments/pay_native/refund") {
      refundPosts++
      const key = init.headers["X-Refund-Idempotency"]
      assert.match(key, /^[a-f0-9]{64}$/)
      if (!refunds.has(key)) {
        refunds.set(key, {
          id: "rfnd_native" + refunds.size,
          amount: body.amount,
          status: "processed",
          payment_id: payment.id,
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
    const collection = await service.createPaymentCollections({
      amount: 123.45,
      currency_code: "inr",
    })
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
          razorpay_order_id: order.id,
          razorpay_payment_id: payment.id,
          razorpay_signature: signature,
        },
      },
    })
    const updated = await service.retrievePaymentSession(session.id)
    assert.equal(updated.data.order_id, order.id)
    assert.equal(updated.data.payment_id, payment.id)
    const native = await service.authorizePaymentSession(session.id, {})
    assert.ok(native)
    assert.equal(native.data.payment_id, payment.id)
    const replay = await service.authorizePaymentSession(session.id, {})
    assert.equal(replay!.id, native.id)
    await service.capturePayment({ payment_id: native.id })
    let saved = await service.retrievePayment(native.id, {
      relations: ["captures", "refunds"],
    })
    assert.equal(saved.captures.length, 1)
    assert.equal(capturePosts, 0)
    await service.refundPayment({
      payment_id: native.id,
      amount: 1,
      idempotency_key: "native_refund_1",
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
    await service.refundPayment({
      payment_id: native.id,
      amount: 2,
      idempotency_key: "native_refund_lost",
    })
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
    console.info(
      "PASS native PostgreSQL: provider registration, session client isolation, authorization replay, one auto-capture, keyed refund replay, lost-response retry, amount guard and webhook replay mapping"
    )
  } finally {
    globalThis.fetch = realFetch
  }
}
