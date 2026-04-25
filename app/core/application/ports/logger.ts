/**
 * Application-layer structured-logging port.
 *
 * Used for cross-cutting observability signals — worker decode/dispatch
 * failures, retry exhaustion, etc. Domain code does not log; usecase happy
 * paths do not log either. Production deployments wire a structured sink
 * (JSON line logger, OTel handler) without touching call sites.
 */
export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  /**
   * By convention, callers put the underlying error / cause under a `cause`
   * key when it is the primary piece of context (matches
   * `new Error(msg, { cause })`).
   */
  error(message: string, meta?: LogMeta): void;
}

/**
 * Default `Logger` implementation that forwards every call to `console`.
 * Suitable for development; production deployments should replace this with
 * a structured-logger implementation.
 */
export const ConsoleLogger: Logger = {
  info: (message, meta) => {
    if (meta === undefined) console.info(message);
    else console.info(message, meta);
  },
  warn: (message, meta) => {
    if (meta === undefined) console.warn(message);
    else console.warn(message, meta);
  },
  error: (message, meta) => {
    if (meta === undefined) console.error(message);
    else console.error(message, meta);
  },
};
