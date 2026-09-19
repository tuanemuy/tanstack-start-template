"use client";

import { useRouter } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  Suspense,
  startTransition,
  type Usable,
  use,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ViewTransition,
} from "react";

type Reconcile = () => Promise<void>;

const ReconcileContext = createContext<Reconcile | null>(null);

// Upper bound on waiting for the router to hand React the re-run loader's
// promise. It only trips if a loader breaks the contract below by returning
// the same promise again; giving up costs a one-frame blink, never a hang.
const DELIVERY_TIMEOUT_MS = 1000;

function Resolved<T extends ReactNode>({ promise }: { promise: Usable<T> }) {
  return use(promise);
}

/**
 * Streams a deferred RSC payload (or any promise) in under a fallback, and
 * keeps it on screen while mutations reconcile it.
 *
 * The route loader forwards the `renderServerComponent(...)` promise WITHOUT
 * awaiting it, so navigation settles immediately and the fragment streams in
 * under `fallback`. The loader must return a new promise on every run.
 *
 * A new `promise` is adopted inside a transition, never rendered directly:
 * `router.invalidate()` yields a fresh unresolved promise, and handing that
 * straight to `use()` would re-suspend the boundary — the fallback flashes and
 * the client islands inside remount, losing their optimistic state.
 *
 * Only the fallback → content reveal is animated. `useOptimistic` commits are
 * urgent, so React never runs a view transition for them, and one around the
 * content would hold the reconciling commit back until the animation ends.
 *
 * This is the per-fragment streaming mechanism. For whole-route navigation
 * pending UI, use the router's `defaultPendingComponent` instead.
 */
export function Deferred<T extends ReactNode>({
  promise,
  fallback,
}: {
  promise: Usable<T>;
  fallback: ReactNode;
}): ReactNode {
  const router = useRouter();
  // Lazy initializer / updater forms: `Usable` admits `Context`, which is
  // callable, so a bare value would be read as an initializer or updater.
  const [shown, setShown] = useState<Usable<T>>(() => promise);
  const waiters = useRef(new Set<() => void>());

  const releaseWaiters = useCallback(() => {
    for (const release of waiters.current) release();
    waiters.current.clear();
  }, []);

  useEffect(() => {
    startTransition(() => setShown(() => promise));
    releaseWaiters();
  }, [promise, releaseWaiters]);

  useEffect(() => releaseWaiters, [releaseWaiters]);

  const reconcile = useCallback<Reconcile>(async () => {
    const delivered = new Promise<void>((resolve) => {
      waiters.current.add(resolve);
      setTimeout(resolve, DELIVERY_TIMEOUT_MS);
    });
    await router.invalidate();
    await delivered;
  }, [router]);

  return (
    <ReconcileContext value={reconcile}>
      <Suspense fallback={<ViewTransition>{fallback}</ViewTransition>}>
        <ViewTransition update="none">
          <Resolved promise={shown} />
        </ViewTransition>
      </Suspense>
    </ReconcileContext>
  );
}

/**
 * Returns the function a mutation awaits, inside its transition, to reconcile
 * with the server after the server function resolves.
 *
 * `await router.invalidate()` alone is not enough under a `Deferred`: it can
 * resolve before the router has handed React the new promise. The mutation's
 * transition then ends first, `useOptimistic` reverts to the stale data, and
 * the fresh data arrives in a later commit — the change blinks off and on.
 * This waits until the new promise has been adopted, which happens in a
 * transition while the mutation is still pending, so React folds the
 * optimistic revert and the fresh payload into a single commit.
 *
 * Outside a `Deferred` there is nothing to wait for, so it falls back to
 * `router.invalidate()`.
 */
export function useReconcile(): Reconcile {
  const router = useRouter();
  const reconcile = useContext(ReconcileContext);
  const invalidate = useCallback<Reconcile>(
    () => router.invalidate(),
    [router],
  );
  return reconcile ?? invalidate;
}
