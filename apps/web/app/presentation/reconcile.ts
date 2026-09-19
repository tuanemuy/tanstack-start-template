import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Returns the function a mutation awaits, inside its transition, to reconcile
 * with the server once its server function has resolved.
 *
 * It is `router.invalidate({ sync: true })`. A plain `router.invalidate()`
 * treats a route that already has data as stale-while-revalidate: it resolves
 * at once and refreshes in the background. The mutation's transition would then
 * end before the fresh data exists, `useOptimistic` would revert to the stale
 * data, and the change would blink off until the refresh lands. `sync` makes
 * the reload blocking, so the promise resolves only after the fresh loader data
 * has been committed and rendered. Navigation keeps stale-while-revalidate.
 */
export function useReconcile(): () => Promise<void> {
  const router = useRouter();
  return useCallback(() => router.invalidate({ sync: true }), [router]);
}
