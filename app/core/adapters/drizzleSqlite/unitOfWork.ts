import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
  WorkerContext,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import {
  DrizzleSqliteOutboxWorkerRepository,
  DrizzleSqliteOutboxWriter,
} from "./repositories/outboxRepository";
import {
  DrizzleSqliteTodoReader,
  DrizzleSqliteTodoRepository,
} from "./repositories/todoRepository";

/**
 * Structured SQLite error codes the write path treats as transient
 * contention worth retrying. Anything else — including the nested-
 * transaction message ("cannot start a transaction within a transaction"),
 * which is a programming bug — must surface so the real cause is visible.
 */
const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

/**
 * Extract a string `code` from a libsql / better-sqlite3 error, if present.
 * Pure: no side effects, no exceptions, just a narrowed lookup that returns
 * `undefined` when the value isn't a string.
 */
function extractErrorCode(error: Error): string | undefined {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Code-first retry classifier — the canonical signal. Modern libsql /
 * better-sqlite3 always populate `error.code` on the locking failures we
 * care about, so this should answer in the common case.
 */
export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_SQLITE_CODES.has(code);
}

/**
 * Message-substring fallback for old driver builds that throw plain `Error`
 * with no structured `code`. Pure function on the lower-cased message so
 * callers can compose it without re-doing the case fold.
 *
 * **Do not extend this without first confirming the matching driver still
 * exists in the supported set.** Every entry here is a maintenance liability
 * — driver authors are free to reword the message at any point. Prefer
 * adding to {@link RETRYABLE_SQLITE_CODES} when a new code surfaces.
 */
export function isRetryableErrorMessage(lowerCaseMessage: string): boolean {
  return (
    lowerCaseMessage.includes("sqlite_busy") ||
    lowerCaseMessage.includes("sqlite_locked") ||
    lowerCaseMessage.includes("database is locked") ||
    lowerCaseMessage.includes("database is busy")
  );
}

/**
 * Composed predicate: true iff the error represents transient write-lock
 * contention worth a retry. Tries the structured code first (driver-stable)
 * and falls back to message substring matching only for legacy throws.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = extractErrorCode(error);
  if (code !== undefined && isRetryableErrorCode(code)) {
    return true;
  }

  return isRetryableErrorMessage(error.message.toLowerCase());
}

/**
 * Plain libsql-backed `UnitOfWorkProvider`.
 *
 * Retries are delegated to `RetryingUnitOfWorkProvider` in the application
 * layer so that the adapter stays focused on wrapping a single transaction.
 * Use {@link isRetryableError} as the predicate when composing.
 *
 * =====================================================================
 * IMPORTANT - libsql transaction behavior (read this before editing):
 * =====================================================================
 *
 * libsql's `db.transaction(fn, behavior)` accepts a `behavior` argument for
 * the transaction mode (`"deferred" | "immediate" | "exclusive"`) but the
 * underlying client **silently ignores it** and always opens a DEFERRED
 * transaction. There is no runtime way to force `BEGIN IMMEDIATE` through
 * the TypeScript driver today.
 *
 * What this means for us:
 *
 *   - We cannot take a write lock at transaction start. Write contention is
 *     detected on the first write statement inside the txn, not at BEGIN.
 *   - For the outbox claim path we rely on SQLite's **statement-level
 *     atomicity** (a single `UPDATE ... WHERE id IN (SELECT ... LIMIT N)`
 *     evaluates subquery and update as one statement). Two concurrent
 *     claimants racing on the same candidate row cannot both succeed: the
 *     loser's predicate no longer matches by the time its write lands.
 *   - For normal writer/writer contention we rely on `PRAGMA busy_timeout`
 *     (the driver-level wait) and on `RetryingUnitOfWorkProvider` (the app-
 *     level retry). `SQLITE_BUSY` eventually surfaces as a retryable error.
 *
 * If libsql ever starts honoring IMMEDIATE this block should be revisited:
 * upgrading would let us take the write lock up front and remove some of
 * the defensive claim-predicate duplication in the outbox adapter.
 * =====================================================================
 */
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(private readonly db: Database) {}

  /**
   * Readonly runs still open a transaction so that multiple reads inside
   * one callback observe a single consistent snapshot (SQLite WAL's
   * deferred read transaction). Callers that issue e.g. a `findAll` plus
   * a `count` can rely on both seeing the same state.
   */
  runReadonly<T>(fn: (ctx: ReadonlyContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;
      const ctx: ReadonlyContext = {
        todoRepository: new DrizzleSqliteTodoReader(executor),
      };
      return fn(ctx);
    });
  }

  runReadWrite<T>(fn: (ctx: ReadWriteContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;
      const todoRepository = new DrizzleSqliteTodoRepository(executor);
      // The outbox writer is private to this method: usecases cannot reach
      // it, they only drop events into `collected` via `collectEvents`.
      // `collectEvents` preserves push order (see `ReadWriteContext` doc).
      const outboxWriter = new DrizzleSqliteOutboxWriter(executor);
      const collected: DomainEvent[] = [];
      const ctx: ReadWriteContext = {
        todoRepository,
        collectEvents: (events) => {
          collected.push(...events);
        },
      };

      const result = await fn(ctx);

      // Persist collected events in the same transaction so that entity
      // changes and event publishing commit atomically together.
      if (collected.length > 0) {
        await outboxWriter.saveEvents(collected);
      }

      return result;
    });
  }

  /**
   * Worker-only transaction. Exposes the
   * {@link DrizzleSqliteOutboxWorkerRepository} (and nothing else) so the
   * event relay worker can claim / mark-processed without pulling domain
   * repositories into scope.
   *
   * The transaction atomicity of the claim path relies on the
   * single-statement `UPDATE ... WHERE id IN (SELECT ...)` semantics of
   * SQLite — see the class-level block above for the libsql quirk that
   * prevents us from using IMMEDIATE mode instead.
   */
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;
      // The phantom `workerContextMarker` property is structural-only — it
      // has no runtime representation. Cast through `unknown` to satisfy
      // the type while keeping the domain port surface marker-free.
      const ctx = {
        outboxRepository: new DrizzleSqliteOutboxWorkerRepository(executor),
      } as unknown as WorkerContext;
      return fn(ctx);
    });
  }
}
