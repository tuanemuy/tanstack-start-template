import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
} from "./unitOfWork";

/**
 * Predicate supplied by the adapter layer: given a thrown value, should the
 * transaction be retried? Keeps the decorator generic while letting the
 * caller encode driver-specific codes (e.g. `SQLITE_BUSY`).
 */
export type IsRetryable = (error: unknown) => boolean;

export type RetryConfig = Readonly<{
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

function calculateRetryDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps any `UnitOfWorkProvider` and retries `run` when the inner call fails
 * with a retryable error (typically transient write-lock contention).
 *
 * Keeping retry as a decorator — instead of baking it into a specific
 * adapter — means switching database drivers only requires supplying a new
 * `isRetryable` predicate, and tests can opt out by composing without this
 * wrapper.
 */
export class RetryingUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly inner: UnitOfWorkProvider,
    private readonly isRetryable: IsRetryable,
    private readonly config: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  run<T>(
    fn: (ctx: ReadWriteContext) => Promise<T>,
    options?: { mode?: "readwrite" },
  ): Promise<T>;
  run<T>(
    fn: (ctx: ReadonlyContext) => Promise<T>,
    options: { mode: "readonly" },
  ): Promise<T>;
  async run<T>(
    fn:
      | ((ctx: ReadWriteContext) => Promise<T>)
      | ((ctx: ReadonlyContext) => Promise<T>),
    options?: { mode?: "readonly" | "readwrite" },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (options?.mode === "readonly") {
          return await this.inner.run(
            fn as (ctx: ReadonlyContext) => Promise<T>,
            { mode: "readonly" },
          );
        }
        return await this.inner.run(
          fn as (ctx: ReadWriteContext) => Promise<T>,
        );
      } catch (error) {
        lastError = error;
        if (this.isRetryable(error) && attempt < this.config.maxRetries) {
          await sleep(calculateRetryDelay(attempt, this.config));
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }
}
