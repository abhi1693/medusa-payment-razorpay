import { expect, it, vi } from "vitest"
import {
  createRazorpayCoordinator,
  type FinancialCoordinationDependencies,
} from "../src"
const sessions = ["payses_A", "payses_B"]
function fixture(sameOrder = true) {
  const resolve = vi.fn(async (ids: string[]) =>
    ids.map((session_id) => ({
      session_id,
      order_id: sameOrder ? "order_shared" : "order_" + session_id.slice(-1),
    }))
  )
  const queues = new Map<string, Promise<void>>()
  const execute: FinancialCoordinationDependencies["execute"] = async (
    keys,
    work
  ) => {
    const previous = keys.map((key) => queues.get(key) || Promise.resolve())
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    for (const key of keys) queues.set(key, done)
    await Promise.all(previous)
    try {
      return await work()
    } finally {
      release()
    }
  }
  return {
    resolve,
    execute,
    coordinate: createRazorpayCoordinator({ resolve, execute }),
  }
}
it.each([true, false])(
  "serializes shared order=%s without blocking unrelated orders",
  async (sameOrder) => {
    const { coordinate } = fixture(sameOrder)
    let active = 0,
      maximum = 0
    const work = async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
    }
    await Promise.all(sessions.map((session) => coordinate([session], work)))
    expect(maximum).toBe(sameOrder ? 1 : 2)
  }
)
it("deduplicates and orders session/order keys consistently", async () => {
  const { resolve } = fixture()
  const calls: string[][] = []
  const execute: FinancialCoordinationDependencies["execute"] = async (
    keys,
    work
  ) => {
    calls.push(keys)
    return work()
  }
  const coordinate = createRazorpayCoordinator({ resolve, execute })
  await expect(
    coordinate([sessions[1], sessions[0], sessions[0]], async () => 7)
  ).resolves.toBe(7)
  expect(calls[0]).toEqual([
    "razorpay:order:order_shared",
    "razorpay:session:payses_A",
    "razorpay:session:payses_B",
  ])
})
it("rejects an association change after lock acquisition before accounting", async () => {
  const { resolve, execute } = fixture()
  resolve
    .mockResolvedValueOnce([
      { session_id: sessions[0], order_id: "order_before" },
    ])
    .mockResolvedValueOnce([
      { session_id: sessions[0], order_id: "order_after" },
    ])
  const work = vi.fn()
  await expect(
    createRazorpayCoordinator({ resolve, execute })([sessions[0]], work)
  ).rejects.toThrow("association changed")
  expect(work).not.toHaveBeenCalled()
})
it("allows an explicitly unattached checkout session using its session lock", async () => {
  const calls: string[][] = []
  const execute: FinancialCoordinationDependencies["execute"] = async (
    keys,
    work
  ) => {
    calls.push(keys)
    return work()
  }
  const coordinate = createRazorpayCoordinator({
    resolve: async () => [{ session_id: sessions[0], order_id: null }],
    execute,
  })
  await coordinate([sessions[0]], async () => undefined)
  expect(calls[0]).toEqual(["razorpay:session:payses_A"])
})
it.each([
  { input: [] },
  { input: ["invalid"] },
  { input: ["payses_A?secret"] },
])("rejects invalid session input %j", async ({ input }) => {
  const { coordinate, resolve } = fixture()
  await expect(coordinate(input, async () => undefined)).rejects.toThrow()
  expect(resolve).not.toHaveBeenCalled()
})
it("rejects incomplete and duplicate trusted mappings", async () => {
  const { resolve, execute } = fixture()
  resolve.mockResolvedValue([])
  await expect(
    createRazorpayCoordinator({ resolve, execute })(
      sessions,
      async () => undefined
    )
  ).rejects.toThrow()
  resolve.mockResolvedValue([
    { session_id: sessions[0], order_id: "order_shared" },
    { session_id: sessions[0], order_id: "order_shared" },
  ])
  await expect(
    createRazorpayCoordinator({ resolve, execute })(
      sessions,
      async () => undefined
    )
  ).rejects.toThrow()
})
it("releases locks when accounting throws so a later retry can enter", async () => {
  const { coordinate } = fixture()
  await expect(
    coordinate([sessions[0]], async () => {
      throw new Error("crash")
    })
  ).rejects.toThrow("crash")
  await expect(
    coordinate([sessions[1]], async () => "recovered")
  ).resolves.toBe("recovered")
})

it("snapshots scalar associations even when a resolver reuses mutable objects", async () => {
  const row = { session_id: sessions[0], order_id: "order_before" }
  const execute: FinancialCoordinationDependencies["execute"] = async (
    _keys,
    work
  ) => {
    row.order_id = "order_after"
    return work()
  }
  const coordinate = createRazorpayCoordinator({
    resolve: async () => [row],
    execute,
  })
  const work = vi.fn()
  await expect(coordinate([sessions[0]], work)).rejects.toThrow(
    "association changed"
  )
  expect(work).not.toHaveBeenCalled()
})
