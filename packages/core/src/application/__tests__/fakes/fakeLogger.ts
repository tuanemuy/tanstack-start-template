import type { Logger, LogMeta } from "@repo/core/application/ports/logger";

export type FakeLogEntry = Readonly<{
  level: "info" | "warn" | "error";
  message: string;
  meta?: LogMeta;
}>;

/**
 * In-memory `Logger` that records every call so tests can assert on
 * observability behaviour without spying on `console`.
 */
export class FakeLogger implements Logger {
  readonly entries: FakeLogEntry[] = [];

  info(message: string, meta?: LogMeta): void {
    this.append("info", message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.append("warn", message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.append("error", message, meta);
  }

  byLevel(level: FakeLogEntry["level"]): FakeLogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  reset(): void {
    this.entries.length = 0;
  }

  private append(
    level: FakeLogEntry["level"],
    message: string,
    meta: LogMeta | undefined,
  ): void {
    if (meta === undefined) {
      this.entries.push({ level, message });
    } else {
      this.entries.push({ level, message, meta });
    }
  }
}
