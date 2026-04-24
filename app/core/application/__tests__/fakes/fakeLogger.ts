import type { Logger, LogMeta } from "@/core/domain/common/ports/logger";

export type FakeLogEntry = Readonly<{
  level: "info" | "warn" | "error";
  message: string;
  meta?: LogMeta;
}>;

/**
 * In-memory `Logger` that records every call so worker / usecase tests can
 * assert on observability behaviour without spying on `console`.
 *
 * Usage:
 *
 *   const logger = new FakeLogger();
 *   // ... run code under test ...
 *   const errors = logger.byLevel("error");
 *   expect(errors).toHaveLength(1);
 *   expect(errors[0]?.message).toMatch(/decode failed/);
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
    // Persist `meta` only when defined so the snapshot matches the call site
    // shape (`{ level, message }` vs `{ level, message, meta }`).
    if (meta === undefined) {
      this.entries.push({ level, message });
    } else {
      this.entries.push({ level, message, meta });
    }
  }
}
