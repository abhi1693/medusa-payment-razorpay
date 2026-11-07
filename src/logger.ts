export const LOG_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
  "none",
] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
export type ActiveLogLevel = Exclude<LogLevel, "none">
export type LoggerSink = Partial<
  Record<"debug" | "info" | "warn" | "error", (message: string) => void>
>
export type LogContext = Readonly<Record<string, unknown>>
export interface LoggerOptions {
  sink?: LoggerSink
  level?: LogLevel
}
export interface PluginLogger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warning(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  critical(message: string, context?: LogContext): void
}
export function validateLogLevel(value: unknown): LogLevel {
  if (value === undefined) return "info"
  if (!LOG_LEVELS.includes(value as LogLevel))
    throw new Error("Invalid Razorpay log level")
  return value as LogLevel
}
export function createLogger({
  sink = console,
  level = "info",
}: LoggerOptions = {}): PluginLogger {
  const minimum = LOG_LEVELS.indexOf(validateLogLevel(level))
  const write = (
    severity: ActiveLogLevel,
    message: string,
    context: LogContext = {}
  ): void => {
    if (minimum === 5 || LOG_LEVELS.indexOf(severity) < minimum) return
    const method =
      severity === "warning"
        ? "warn"
        : severity === "critical"
          ? "error"
          : severity
    try {
      ;(sink[method] || sink.info)?.call(
        sink,
        JSON.stringify({ level: severity, message, context })
      )
    } catch {
      /* Logging must not alter payment behavior. */
    }
  }
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warning: (message, context) => write("warning", message, context),
    error: (message, context) => write("error", message, context),
    critical: (message, context) => write("critical", message, context),
  }
}
