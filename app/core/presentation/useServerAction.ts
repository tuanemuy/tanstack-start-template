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
 * - `"all"` (default): refetch every active loader.
 * - `"none"`: skip invalidation.
 * - function: caller supplies the invalidation; the returned promise is awaited.
 */
export type InvalidateStrategy = "all" | "none" | (() => void | Promise<void>);

export type UseServerActionOptions<TArgs extends unknown[], TResult> = {
  onError?: ErrorHandlers;
  onSuccess?: (result: TResult) => void;
  /**
   * Fired synchronously at the start of the call — use this to dispatch
   * `useOptimistic` updates. Only effective when `transition !== false`.
   */
  onOptimistic?: (...args: TArgs) => void;
  invalidate?: InvalidateStrategy;
  /**
   * When `false`, bypass `useTransition` so UI updates apply immediately.
   * Defaults to `true`.
   */
  transition?: boolean;
};

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

          try {
            const result = await fnRef.current(...args);

            const invalidate = opts?.invalidate;
            if (typeof invalidate === "function") {
              await invalidate();
            } else if (invalidate !== "none") {
              await router.invalidate();
            }

            setLastError(null);
            opts?.onSuccess?.(result);
            resolve({ ok: true, data: result });
          } catch (error) {
            const serialized = extractSerializedError(error);
            setLastError(serialized);
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

  const clearLastError = useCallback(() => setLastError(null), []);

  return {
    run,
    isPending: transitionPending || directPending,
    lastError,
    clearLastError,
  };
}
