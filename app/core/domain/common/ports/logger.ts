/**
 * Structured-logging port.
 *
 * Application code that wants to emit observability signals — worker
 * decode/dispatch failures, retry exhaustion, etc. — calls into this port
 * rather than `console.error` directly so that:
 *
 * - Production deployments can wire a structured sink (JSON line logger,
 *   OTel handler) without touching call sites.
 * - Tests can capture log calls with a `FakeLogger` and assert on them.
 * - The logging surface stays narrow on purpose: no `debug` / `trace`
 *   levels, no formatting helpers — just the three levels the application
 *   layer actually needs today (`info` / `warn` / `error`).
 *
 * `meta` is an optional structured payload (already JSON-safe at the call
 * site). Implementations decide how to render it (key=value, JSON, drop).
 */
export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  /**
   * `error` accepts an optional `meta` payload. By convention, callers put
   * the underlying error / cause under a `cause` key when it is the primary
   * piece of context (matches `new Error(msg, { cause })`).
   */
  error(message: string, meta?: LogMeta): void;
}

/**
 * `Logger` implementation that forwards every call to `console`.
 *
 * Suitable as the default sink: Node's `console.*` is already async-flushed
 * and JSON-aware enough for development. Production deployments should
 * replace this with a structured-logger implementation.
 */
export const ConsoleLogger: Logger = {
  info: (message, meta) => {
    if (meta === undefined) {
      console.info(message);
    } else {
      console.info(message, meta);
    }
  },
  warn: (message, meta) => {
    if (meta === undefined) {
      console.warn(message);
    } else {
      console.warn(message, meta);
    }
  },
  error: (message, meta) => {
    if (meta === undefined) {
      console.error(message);
    } else {
      console.error(message, meta);
    }
  },
};
