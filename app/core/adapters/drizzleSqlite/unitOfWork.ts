import { type RetryOptions, retry } from "@/core/application/execution/retry";
import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
// Importing the port file is what loads its `declare module` augmentation
// (the `todoRepository: TodoRepository` slot on `UnitOfWorkContext`). Without
// this side-effect import the assignment below would not type-check.
import "@/core/domain/todo/ports/todoRepository";
import type { Database, Executor } from "./client";
import { DrizzleSqliteOutboxRepository } from "./repositories/outboxRepository";
import { DrizzleSqliteTodoRepository } from "./repositories/todoRepository";

/**
 * SQLite error codes the write path treats as transient contention worth
 * retrying internally (see `retryConfig` below). These are driver-level
 * implementation details that should never leak to application code, so the
 * adapter handles them itself rather than exposing a decorator.
 */
const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_SQLITE_CODES.has(code);
}

export type DrizzleSqliteUnitOfWorkRetryConfig = Readonly<{
  /** Maximum number of attempts including the initial try. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

const DEFAULT_RETRY_CONFIG: DrizzleSqliteUnitOfWorkRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

function calculateDelay(
  attempt: number,
  config: DrizzleSqliteUnitOfWorkRetryConfig,
): number {
  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponential + jitter, config.maxDelayMs);
}

/**
 * Drizzle-backed `UnitOfWorkProvider`.
 *
 * Each `run` call opens a transaction, hands the callback a context that
 * exposes the domain repositories plus `collectEvents`, and flushes the
 * collected events to the outbox in the same transaction once the callback
 * resolves.
 *
 * ## Transient retry (SQLite-internal)
 *
 * `SQLITE_BUSY` / `SQLITE_LOCKED` failures from write-lock contention are
 * retried inside `run()` with exponential backoff. This is a driver-level
 * concern — application code never sees these codes — so the retry lives
 * here rather than as a decorator at the application layer.
 *
 * Application-level OCC retry (`ConflictError(OptimisticLockFailure)`) is
 * a different error class and is handled by the usecase that knows the
 * mutation is idempotent (e.g. `changeTodoStatus`). The two layers compose
 * without double-retry.
 *
 * ## Side-effect warning
 *
 * A retry re-executes the callback from the top. Only DB work inside the
 * transaction (repository writes, events from `collectEvents`) is rolled
 * back. Any external side effect performed by the callback (HTTP, telemetry,
 * cache mutation) will run again on each attempt — keep the callback pure
 * with respect to external systems.
 */
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly db: Database,
    retryConfig: DrizzleSqliteUnitOfWorkRetryConfig = DEFAULT_RETRY_CONFIG,
  ) {
    this.retryOptions = {
      maxAttempts: retryConfig.maxAttempts,
      shouldRetry: isRetryableError,
      delayMs: (attempt) => calculateDelay(attempt, retryConfig),
    };
  }

  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return retry(() => this.runOnce(fn), this.retryOptions);
  }

  private runOnce<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor = tx as Executor;
      const todoRepository = new DrizzleSqliteTodoRepository(executor);
      const outbox = new DrizzleSqliteOutboxRepository(executor);
      const collected: DomainEvent[] = [];
      const ctx: UnitOfWorkContext = {
        todoRepository,
        collectEvents: (events) => {
          collected.push(...events);
        },
      };

      const result = await fn(ctx);

      if (collected.length > 0) {
        await outbox.save(collected);
      }

      return result;
    });
  }
}
