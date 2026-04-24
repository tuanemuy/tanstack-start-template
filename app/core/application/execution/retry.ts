/**
 * Predicate the caller injects to classify a thrown value.
 *
 * Returning `true` means "this is the kind of failure we should retry";
 * returning `false` short-circuits the loop and re-throws the error
 * immediately. Keeping the predicate caller-supplied keeps the retry
 * mechanism agnostic of any specific error taxonomy (driver code, application
 * error subclass, …).
 */
export type ShouldRetry = (error: unknown) => boolean;

export type RetryOptions = Readonly<{
  /**
   * Maximum number of attempts, including the initial call. `maxAttempts: 3`
   * runs at most three total executions, not three retries on top of one.
   */
  maxAttempts: number;
  shouldRetry: ShouldRetry;
  delayMs?: (attempt: number) => number | Promise<number>;
  /**
   * Optional observability hook fired right before each retry sleep. The
   * hook receives the attempt number that just failed (1-indexed) and the
   * thrown value. Use this when the caller wants to count attempts or log
   * transient failures without coupling that bookkeeping into `retry`'s
   * return type.
   */
  onRetry?: (attempt: number, error: unknown) => void;
}>;

/**
 * Run `fn`, retrying transient failures while `shouldRetry` accepts the
 * thrown value. Returns the resolved value on success and re-throws the
 * last error verbatim when:
 *
 * - `shouldRetry` rejects an error (short-circuit, no further attempts), or
 * - `maxAttempts` is exhausted while `shouldRetry` keeps accepting errors.
 *
 * No custom Result wrapper, no error wrapping — the original error reaches
 * the caller untouched, so its identity (typed subclass, `code`, `cause`)
 * survives end-to-end. Callers who want to convert "retryable but exhausted"
 * into a typed application error (e.g. `ConflictError`) can `try / catch`
 * around `retry` and run the same `shouldRetry` predicate again on the
 * caught value.
 *
 * The callback is re-executed from the top on every retry, so callers should
 * only wrap operations that are safe to run more than once. See
 * `RetryingUnitOfWorkProvider` for the side-effect warning that applies to
 * any retried callback.
 *
 * `RangeError` is thrown up front for a non-positive-integer `maxAttempts`:
 * that is a programming bug, not a runtime condition the caller should
 * handle.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError("retry maxAttempts must be an integer greater than 0");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const classifiedRetryable = options.shouldRetry(error);
      const hasRemainingAttempts = attempt < options.maxAttempts;

      if (!classifiedRetryable || !hasRemainingAttempts) {
        throw error;
      }

      options.onRetry?.(attempt, error);

      const delayMs = await options.delayMs?.(attempt);
      if (delayMs && delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  // Unreachable in practice — the loop either returns or throws on every
  // iteration. The defensive throw keeps the type-checker happy without
  // pretending we have a meaningful value to return.
  throw lastError ?? new Error("retry: no attempts were executed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
