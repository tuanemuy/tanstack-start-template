import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
  WorkerContext,
} from "./unitOfWork";

/**
 * Predicate supplied by the adapter layer: given a thrown value, should the
 * transaction be retried? Keeps the decorator generic while letting the
 * caller encode driver-specific codes (e.g. `SQLITE_BUSY`).
 */
export type IsRetryable = (error: unknown) => boolean;

export type RetryConfig = Readonly<{
  /**
   * Maximum number of attempts (including the initial try). `maxAttempts: 3`
   * runs at most three total executions of the callback, not three retries on
   * top of an initial attempt.
   */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
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
 * Wraps any `UnitOfWorkProvider` and retries `run` / `runWorker` when the
 * inner call fails with a retryable error (typically transient write-lock
 * contention).
 *
 * Keeping retry as a decorator — instead of baking it into a specific
 * adapter — means switching database drivers only requires supplying a new
 * `isRetryable` predicate, and tests can opt out by composing without this
 * wrapper.
 *
 * ## Side-effect warning
 *
 * A retry re-executes the callback from the top. Only work performed inside
 * the DB transaction (repository writes, events accumulated through
 * `collectEvents`) is rolled back when a retryable error fires. **External
 * side effects performed by the callback will be duplicated on every
 * attempt**, including:
 *
 * - HTTP / RPC calls to other services
 * - writes to external message queues or telemetry sinks
 * - logs sent to third-party aggregators
 * - mutations to in-memory caches or module-scope state
 *
 * Recommended pattern: keep the UoW callback pure with respect to external
 * systems (pull inputs in, hand outputs back via the return value) and fire
 * the external effect *after* `run` / `runWorker` resolves successfully.
 * Outbox events are the canonical way to turn "commit implies side effect"
 * into an at-least-once guarantee across system boundaries.
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
  /**
   * @see {@link RetryingUnitOfWorkProvider} for the side-effect warning that
   *   applies to every retried callback — external effects (HTTP, logs,
   *   in-memory caches) run once per attempt while DB work is rolled back.
   *   Keep the callback pure; run external effects after `run` resolves.
   */
  async run<T>(
    fn:
      | ((ctx: ReadWriteContext) => Promise<T>)
      | ((ctx: ReadonlyContext) => Promise<T>),
    options?: { mode?: "readonly" | "readwrite" },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        if (options?.mode === "readonly") {
          return await this.inner.run(
            fn as (ctx: ReadonlyContext) => Promise<T>,
            options as { mode: "readonly" },
          );
        }
        return await this.inner.run(
          fn as (ctx: ReadWriteContext) => Promise<T>,
          options as { mode?: "readwrite" } | undefined,
        );
      } catch (error) {
        lastError = error;
        if (this.isRetryable(error) && attempt < this.config.maxAttempts) {
          await sleep(calculateRetryDelay(attempt, this.config));
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Retrying variant of {@link UnitOfWorkProvider.runWorker}.
   *
   * @see {@link RetryingUnitOfWorkProvider} for the side-effect warning that
   *   applies to every retried callback — external effects (HTTP dispatch,
   *   logs, in-memory caches) run once per attempt while DB work is rolled
   *   back. In particular, do NOT perform event dispatch inside this
   *   callback: claim the batch here, dispatch outside, then mark processed
   *   in another `runWorker` call.
   */
  async runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await this.inner.runWorker(fn);
      } catch (error) {
        lastError = error;
        if (this.isRetryable(error) && attempt < this.config.maxAttempts) {
          await sleep(calculateRetryDelay(attempt, this.config));
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }
}
