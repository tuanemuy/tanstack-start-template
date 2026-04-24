"use client";

import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef, useState, useTransition } from "react";
import {
  extractSerializedError,
  type SerializedError,
  type SerializedErrorKind,
} from "@/core/presentation/errorResponse";

export type ErrorHandlers = Partial<
  Record<SerializedErrorKind | "default", (error: SerializedError) => void>
>;

export type ServerActionResult<TResult> =
  | { ok: true; data: TResult }
  | { ok: false; error: SerializedError };

/**
 * Router invalidation strategy applied after a successful call.
 *
 * - `"all"` (default): `await router.invalidate()` — refetch every active
 *   loader. Matches the previous implicit behaviour.
 * - `"none"`: do not invalidate. Useful when the action is purely client-side
 *   or the caller will invalidate on its own terms.
 * - function: the caller runs the invalidation itself (e.g.
 *   `router.invalidate({ filter: ... })`). The return value is awaited so
 *   the promise resolves after refetch completes.
 */
export type InvalidateStrategy = "all" | "none" | (() => void | Promise<void>);

/**
 * Auto-retry configuration for transient errors (where
 * `SerializedError.retryable === true`). The retry happens inside the hook
 * with exponential backoff; user-visible handlers (`onError` / `onSuccess`)
 * only fire for the final outcome.
 */
export type AutoRetryOptions = {
  /** Including the initial call. `1` disables retry. */
  maxAttempts: number;
  /** Delay before the first retry; subsequent attempts double (exp backoff). */
  baseDelayMs: number;
};

export type UseServerActionOptions<TArgs extends unknown[], TResult> = {
  onError?: ErrorHandlers;
  onSuccess?: (result: TResult) => void;
  /**
   * Fired synchronously at the start of the call — use this to dispatch
   * `useOptimistic` updates. Only effective when `transition !== false`,
   * since React's optimistic updates require a transition to apply.
   */
  onOptimistic?: (...args: TArgs) => void;
  /**
   * Router invalidation strategy. See {@link InvalidateStrategy}. Defaults
   * to `"all"` for backwards compatibility.
   */
  invalidate?: InvalidateStrategy;
  /**
   * When `false`, bypass `useTransition` so UI updates apply immediately.
   * Useful for urgent feedback (form submission, toggle). Defaults to `true`.
   */
  transition?: boolean;
  /**
   * Auto-retry retryable errors (conflict / network / external-api) with
   * exponential backoff before reporting failure to the caller. Defaults to
   * no retry.
   */
  autoRetry?: AutoRetryOptions;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wraps a server function with router invalidation, transition handling, and
 * kind-specific error routing. The hook owns no error-message state — callers
 * decide how to surface failures (inline, toast, field-level, navigate) from
 * inside each handler.
 *
 * `run` is referentially stable and returns a discriminated result so callers
 * can `await` it to sequence follow-up work, while `onError` / `onSuccess`
 * still fire for declarative side effects. `lastError` exposes the most
 * recent failure so the UI can render field-level messages (e.g. via
 * `SerializedValidationError.fieldErrors`) without bookkeeping its own state.
 */
export function useServerAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: UseServerActionOptions<TArgs, TResult>,
) {
  const router = useRouter();
  const [transitionPending, startTransition] = useTransition();
  const [directPending, setDirectPending] = useState(false);
  const [lastError, setLastError] = useState<SerializedError | null>(null);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const run = useCallback(
    (...args: TArgs): Promise<ServerActionResult<TResult>> => {
      return new Promise((resolve) => {
        const execute = async () => {
          const opts = optionsRef.current;
          opts?.onOptimistic?.(...args);

          const autoRetry = opts?.autoRetry;
          const maxAttempts = Math.max(1, autoRetry?.maxAttempts ?? 1);
          const baseDelayMs = autoRetry?.baseDelayMs ?? 0;

          // Retry loop: standard for-loop, no pipe/compose. We bail on the
          // first non-retryable failure or after `maxAttempts` tries.
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
              const result = await fnRef.current(...args);

              const invalidate = opts?.invalidate;
              if (typeof invalidate === "function") {
                await invalidate();
              } else if (invalidate === "none") {
                // caller opted out
              } else {
                // "all" (default) or undefined
                await router.invalidate();
              }

              setLastError(null);
              opts?.onSuccess?.(result);
              resolve({ ok: true, data: result });
              return;
            } catch (error) {
              const serialized = extractSerializedError(error);
              const shouldRetry =
                serialized.retryable === true && attempt < maxAttempts;
              if (shouldRetry) {
                // Exponential backoff: base, base*2, base*4, ...
                const delay = baseDelayMs * 2 ** (attempt - 1);
                if (delay > 0) await sleep(delay);
                continue;
              }
              setLastError(serialized);
              const handler =
                opts?.onError?.[serialized.kind] ?? opts?.onError?.default;
              handler?.(serialized);
              resolve({ ok: false, error: serialized });
              return;
            }
          }
        };

        if (optionsRef.current?.transition === false) {
          setDirectPending(true);
          void execute().finally(() => setDirectPending(false));
        } else {
          startTransition(execute);
        }
      });
    },
    [router],
  );

  const clearLastError = useCallback(() => setLastError(null), []);

  return {
    run,
    isPending: transitionPending || directPending,
    lastError,
    clearLastError,
  };
}
