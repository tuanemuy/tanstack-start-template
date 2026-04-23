import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
  WorkerContext,
} from "@/core/application/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import { DrizzleSqliteOutboxRepository } from "./repositories/outboxRepository";
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
    // Readonly runs still open a transaction so that multiple reads inside
    // one callback observe a single consistent snapshot (SQLite WAL's
    // deferred read transaction). Callers that issue e.g. a `findAll` plus
    // a `count` can rely on both seeing the same state.
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;

      if (mode === "readonly") {
        const ctx: ReadonlyContext = {
          todoRepository: new DrizzleSqliteTodoReader(executor),
        };
        return (fn as (ctx: ReadonlyContext) => Promise<T>)(ctx);
      }

      const todoRepository = new DrizzleSqliteTodoRepository(executor);
      // The outbox writer is private to this method: usecases cannot reach
      // it, they only drop events into `collected` via `collectEvents`.
      const outboxRepository = new DrizzleSqliteOutboxRepository(executor);
      const collected: DomainEvent[] = [];
      const ctx: ReadWriteContext = {
        todoRepository,
        collectEvents: (events) => {
          collected.push(...events);
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

  /**
   * Worker-only transaction. Exposes the full `OutboxRepository` (and
   * nothing else) so the event relay worker can claim / mark-processed /
   * read pending entries without pulling domain repositories into scope.
   *
   * The transaction atomicity of the claim path (the "SELECT candidate ids
   * -> UPDATE those rows" pair inside `claimPending`) relies on the
   * single-statement `UPDATE ... WHERE id IN (SELECT ...)` semantics of
   * SQLite: the subquery is evaluated as part of the same statement that
   * performs the write, so concurrent claimants cannot interleave between
   * the read and the write.
   *
   * libsql's `db.transaction(fn, behavior)` accepts a second argument for
   * the transaction behavior but ignores it — the underlying client always
   * opens a DEFERRED transaction. We rely on the single-statement claim
   * semantics above rather than trying to force IMMEDIATE mode through an
   * option that the driver silently drops.
   */
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;
      const ctx: WorkerContext = {
        outboxRepository: new DrizzleSqliteOutboxRepository(executor),
      };
      return fn(ctx);
    });
  }
}
