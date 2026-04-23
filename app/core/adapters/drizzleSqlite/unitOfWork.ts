import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
} from "@/core/application/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import {
  DrizzleSqliteOutboxReader,
  DrizzleSqliteOutboxRepository,
} from "./repositories/outboxRepository";
import {
  DrizzleSqliteTodoReader,
  DrizzleSqliteTodoRepository,
} from "./repositories/todoRepository";

/**
 * libsql / better-sqlite3 surface a `code` property on thrown errors for the
 * cases we want to retry (contention on the write lock). We intentionally
 * narrow against the structured code first and fall back to message matching
 * only so older driver versions stay covered.
 *
 * `SQLITE_BUSY` / `SQLITE_LOCKED` are the two retryable conditions. The
 * text "cannot start a transaction within a transaction" indicates a nested
 * UoW call (a programming bug) rather than transient contention, so we let
 * it propagate rather than silently retrying.
 */
const RETRYABLE_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_SQLITE_CODES.has(code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("sqlite_busy") ||
    message.includes("sqlite_locked") ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

/**
 * Plain libsql-backed `UnitOfWorkProvider`.
 *
 * Retries are delegated to `RetryingUnitOfWorkProvider` in the application
 * layer so that the adapter stays focused on wrapping a single transaction.
 * Use {@link isRetryableError} as the predicate when composing.
 */
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(private readonly db: Database) {}

  run<T>(
    fn: (ctx: ReadWriteContext) => Promise<T>,
    options?: { mode?: "readwrite" },
  ): Promise<T>;
  run<T>(
    fn: (ctx: ReadonlyContext) => Promise<T>,
    options: { mode: "readonly" },
  ): Promise<T>;
  run<T>(
    fn:
      | ((ctx: ReadWriteContext) => Promise<T>)
      | ((ctx: ReadonlyContext) => Promise<T>),
    options?: { mode?: "readonly" | "readwrite" },
  ): Promise<T> {
    const mode = options?.mode ?? "readwrite";
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;

      if (mode === "readonly") {
        const ctx: ReadonlyContext = {
          todoRepository: new DrizzleSqliteTodoReader(executor),
          outboxRepository: new DrizzleSqliteOutboxReader(executor),
        };
        return (fn as (ctx: ReadonlyContext) => Promise<T>)(ctx);
      }

      const todoRepository = new DrizzleSqliteTodoRepository(executor);
      const outboxRepository = new DrizzleSqliteOutboxRepository(executor);
      const collected: DomainEvent[] = [];
      const ctx: ReadWriteContext = {
        todoRepository,
        outboxRepository,
        collectEvent: (event) => {
          collected.push(event);
        },
      };

      const result = await (fn as (ctx: ReadWriteContext) => Promise<T>)(ctx);

      // Persist collected events in the same transaction so that entity
      // changes and event publishing commit atomically together.
      if (collected.length > 0) {
        await outboxRepository.saveEvents(collected);
      }

      return result;
    });
  }
}
