import { it, expect, vi } from "vitest"
import {
  createLogger,
  LOG_LEVELS,
  validateLogLevel,
  type PluginLogger,
} from "../src/logger"
it("applies all severity thresholds and silent none", () => {
  for (let index = 0; index < LOG_LEVELS.length; index++) {
    const sink = vi.fn(),
      logger = createLogger({
        sink: { debug: sink, info: sink, warn: sink, error: sink },
        level: LOG_LEVELS[index],
      })
    for (const level of LOG_LEVELS.slice(0, 5))
      logger[level as keyof PluginLogger]("Example")
    expect(sink).toHaveBeenCalledTimes(index === 5 ? 0 : 5 - index)
  }
})
it("validates configuration", () => {
  expect(validateLogLevel(undefined)).toBe("info")
  for (const value of [null, "verbose", ""])
    expect(() => validateLogLevel(value)).toThrow()
})
it("preserves arbitrary provider response keys without mutating the input", () => {
  const sink = vi.fn(),
    response = {
      error: {
        code: "NEW_ERROR",
        description: "invalid request sent",
        source: "NA",
        step: "NA",
        reason: "NA",
        metadata: { new_field: 42 },
      },
      extra: { future_field: "visible" },
    }
  createLogger({ sink: { debug: sink }, level: "debug" }).debug(
    "Provider response",
    { response }
  )
  const record = JSON.parse(sink.mock.calls[0][0])
  expect(record.context.response).toEqual(response)
  expect(Object.keys(record).sort()).toEqual(["context", "level", "message"])
})
it("logs complete context unchanged in the requested debugging mode", () => {
  const sink = vi.fn(),
    response = {
      email: "person@example.com",
      notes: { custom: "visible" },
      unknown_field: "new value",
    }
  createLogger({ sink: { debug: sink }, level: "debug" }).debug(
    "Provider response",
    { response }
  )
  expect(JSON.parse(sink.mock.calls[0][0]).context.response).toEqual(response)
})
it("preserves complete paths and non-sensitive pagination parameters", () => {
  const sink = vi.fn()
  createLogger({ sink: { debug: sink }, level: "debug" }).debug("Request", {
    path: "payments/pay_fixture/refunds?count=100&skip=0",
  })
  expect(JSON.parse(sink.mock.calls[0][0]).context.path).toBe(
    "payments/pay_fixture/refunds?count=100&skip=0"
  )
})
it("does not serialize data when logging is disabled", () => {
  const sink = vi.fn(),
    value = {
      toJSON: () => {
        throw Error("should not serialize")
      },
    }
  createLogger({ sink: { debug: sink }, level: "none" }).debug("Ignored", {
    value,
  })
  expect(sink).not.toHaveBeenCalled()
})
it("logger failures never escape", () => {
  expect(() =>
    createLogger({
      sink: {
        warn: () => {
          throw Error("logger")
        },
      },
    }).warning("Failure")
  ).not.toThrow()
})
