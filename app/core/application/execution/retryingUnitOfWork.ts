import { retry } from "./retry";
import type { UnitOfWorkContext, UnitOfWorkProvider } from "./unitOfWork";

/**
 * Predicate the adapter layer supplies: given a thrown value, should the
 * transaction be retried? Lets the decorator stay generic while letting the
 * caller encode driver-specific codes (e.g. `SQLITE_BUSY`).
 */
export type IsRetryable = (error: unknown) => boolean;

export type RetryConfig = Readonly<{
  /** Maximum number of attempts including the initial try. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/**
 * Decorator that retries `run()` when the inner call fails with a transient
 * driver error (typically write-lock contention).
 *
 * Operates on a different error class than the application-level OCC retry
 * inside usecases: this layer covers `SQLITE_BUSY` / `SQLITE_LOCKED`, while
 * the usecase loop covers `ConflictError(OptimisticLockFailure)`. They never
 * trigger on the same error, so the two layers compose without double-retry.
 *
 * ## Side-effect warning
 *
 * A retry re-executes the callback from the top. Only DB work inside the
 * transaction (repository writes, events from `collectEvents`) is rolled
 * back. Any external side effect performed by the callback (HTTP, telemetry,
 * cache mutation) will run again on each attempt — keep the callback pure
 * with respect to external systems.
 */
export class RetryingUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly inner: UnitOfWorkProvider,
    private readonly isRetryable: IsRetryable,
    private readonly config: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return retry(() => this.inner.run(fn), {
      maxAttempts: this.config.maxAttempts,
      shouldRetry: this.isRetryable,
      delayMs: (attempt) => calculateDelay(attempt, this.config),
    });
  }
}

function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponential + jitter, config.maxDelayMs);
}
