import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import { DrizzleSqliteOutboxRepository } from "./repositories/outboxRepository";
import { DrizzleSqliteTodoRepository } from "./repositories/todoRepository";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drizzle-backed `UnitOfWorkProvider`. SQLITE_BUSY / SQLITE_LOCKED failures
 * are retried internally with exponential backoff so application code never
 * sees those codes. A retry re-executes the callback from the top — keep it
 * pure with respect to external side effects.
 */
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly db: Database,
    private readonly retryConfig: DrizzleSqliteUnitOfWorkRetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const { maxAttempts } = this.retryConfig;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runOnce(fn);
      } catch (error) {
        if (!isRetryableError(error) || attempt >= maxAttempts) {
          throw error;
        }
        await sleep(calculateDelay(attempt, this.retryConfig));
      }
    }
    throw new Error("unreachable: retry loop exited without returning");
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
