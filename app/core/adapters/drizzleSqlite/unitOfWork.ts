import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import { DrizzleSqliteOutboxRepository } from "./repositories/outboxRepository";
import { DrizzleSqliteTodoRepository } from "./repositories/todoRepository";

/**
 * SQLite error codes the write path treats as transient contention worth
 * retrying. Used as the `isRetryable` predicate when composing
 * `RetryingUnitOfWorkProvider`.
 */
const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_SQLITE_CODES.has(code);
}

/**
 * Drizzle-backed `UnitOfWorkProvider`.
 *
 * Each `run` call opens a transaction, hands the callback a context that
 * exposes the domain repositories plus `collectEvents`, and flushes the
 * collected events to the outbox in the same transaction once the callback
 * resolves. Retry on transient contention is handled by composing this
 * adapter with `RetryingUnitOfWorkProvider`.
 */
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(private readonly db: Database) {}

  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
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
