import { retry } from "./retry";
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

/**
 * Wraps any `UnitOfWorkProvider` and retries `runReadonly` / `runReadWrite` /
 * `runWorker` when the inner call fails with a retryable error (typically
 * transient write-lock contention).
 *
 * Keeping retry as a decorator — instead of baking it into a specific
 * adapter — means switching database drivers only requires supplying a new
 * `isRetryable` predicate, and tests can opt out by composing without this
 * wrapper.
 *
 * ## Retry layering (driver-level first, app-level fallback)
 *
 * The SQLite busy timeout (`PRAGMA busy_timeout`) is the first line of
 * defence against write-lock contention: the driver blocks briefly inside
 * the offending statement rather than surfacing `SQLITE_BUSY` immediately.
 * The app-level retry here kicks in only when the driver has exhausted its
 * own wait and surfaces the transient error to us. The two layers stack:
 * configure `busy_timeout` to absorb short contention waits, and keep this
 * decorator as the belt-and-braces retry for the rare case where contention
 * outlasts the driver timeout. `isRetryable` is injected at wire time so
 * adapter-specific codes stay out of this module.
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
 * the external effect *after* `runReadWrite` / `runWorker` resolves
 * successfully. Outbox events are the canonical way to turn "commit
 * implies side effect" into an at-least-once guarantee across system
 * boundaries.
 */
export class RetryingUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly inner: UnitOfWorkProvider,
    private readonly isRetryable: IsRetryable,
    private readonly config: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  /**
   * @see {@link RetryingUnitOfWorkProvider} for the side-effect warning.
   */
  async runReadonly<T>(fn: (ctx: ReadonlyContext) => Promise<T>): Promise<T> {
    return this.runWithRetry(() => this.inner.runReadonly(fn));
  }

  /**
   * @see {@link RetryingUnitOfWorkProvider} for the side-effect warning.
   */
  async runReadWrite<T>(fn: (ctx: ReadWriteContext) => Promise<T>): Promise<T> {
    return this.runWithRetry(() => this.inner.runReadWrite(fn));
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
    return this.runWithRetry(() => this.inner.runWorker(fn));
  }

  private async runWithRetry<T>(attempt: () => Promise<T>): Promise<T> {
    // `retry` re-throws the last error verbatim when retryable attempts run
    // out (or when `shouldRetry` rejects the error on the first attempt), so
    // the decorator can simply forward the call. The `UnitOfWorkProvider`
    // contract — `Promise<T>` plus thrown errors on failure — passes through
    // unchanged.
    return retry(attempt, {
      maxAttempts: this.config.maxAttempts,
      shouldRetry: this.isRetryable,
      delayMs: (i) => calculateRetryDelay(i, this.config),
    });
  }
}
