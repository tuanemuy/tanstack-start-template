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
   * - `true` (default): await `router.invalidate()` after a successful call
   * - `false`: skip invalidation entirely
   * - function: run custom invalidation (awaited if it returns a Promise)
   */
  invalidate?: boolean | (() => void | Promise<void>);
  /**
   * When `false`, bypass `useTransition` so UI updates apply immediately.
   * Useful for urgent feedback (form submission, toggle). Defaults to `true`.
   */
  transition?: boolean;
};

/**
 * Wraps a server function with router invalidation, transition handling, and
 * kind-specific error routing. The hook owns no error-message state — callers
 * decide how to surface failures (inline, toast, field-level, navigate) from
 * inside each handler.
 *
 * `run` is referentially stable and returns a discriminated result so callers
 * can `await` it to sequence follow-up work, while `onError` / `onSuccess`
 * still fire for declarative side effects.
 */
export function useServerAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: UseServerActionOptions<TArgs, TResult>,
) {
  const router = useRouter();
  const [transitionPending, startTransition] = useTransition();
  const [directPending, setDirectPending] = useState(false);

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
          try {
            const result = await fnRef.current(...args);

            const invalidate = opts?.invalidate;
            if (typeof invalidate === "function") {
              await invalidate();
            } else if (invalidate !== false) {
              await router.invalidate();
            }

            opts?.onSuccess?.(result);
            resolve({ ok: true, data: result });
          } catch (error) {
            const serialized = extractSerializedError(error);
            const handler =
              opts?.onError?.[serialized.kind] ?? opts?.onError?.default;
            handler?.(serialized);
            resolve({ ok: false, error: serialized });
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

  return { run, isPending: transitionPending || directPending };
}
