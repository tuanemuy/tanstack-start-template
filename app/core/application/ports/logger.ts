export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  // By convention, callers put the underlying error under a `cause` key.
  error(message: string, meta?: LogMeta): void;
}

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
