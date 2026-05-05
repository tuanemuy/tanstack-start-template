import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { Clock } from "@/core/application/ports/clock";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Database, Executor } from "./client";
import { DrizzleSqliteOutboxRepository } from "./repositories/outboxRepository";
import { DrizzleSqliteTodoRepository } from "./repositories/todoRepository";

const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

function getErrorCode(err: unknown): string | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
  ) {
    return err.code;
  }
  return null;
}

// Walks the `cause` chain because `mapDbError` wraps driver errors in
// `SystemError`, which exposes its own SystemErrorCode on `.code` and stashes
// the original SQLite error (carrying SQLITE_BUSY / SQLITE_LOCKED) on `.cause`.
function isRetryableError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = getErrorCode(current);
    if (code !== null && RETRYABLE_SQLITE_CODES.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
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

// Retries SQLITE_BUSY / SQLITE_LOCKED with exponential backoff. The callback
// is re-executed from the top, so external side effects must be idempotent.
export class DrizzleSqliteUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly retryConfig: DrizzleSqliteUnitOfWorkRetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.attempt(fn, 1);
  }

  private async attempt<T>(
    fn: (ctx: UnitOfWorkContext) => Promise<T>,
    n: number,
  ): Promise<T> {
    try {
      return await this.runOnce(fn);
    } catch (error) {
      if (!isRetryableError(error) || n >= this.retryConfig.maxAttempts) {
        throw error;
      }
      await sleep(calculateDelay(n, this.retryConfig));
      return this.attempt(fn, n + 1);
    }
  }

  private runOnce<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const executor: Executor = tx;
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
        await outbox.save(collected, this.clock.now());
      }

      return result;
    });
  }
}
