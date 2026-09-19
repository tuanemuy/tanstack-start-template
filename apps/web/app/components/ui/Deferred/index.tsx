"use client";

import {
  type ReactNode,
  Suspense,
  startTransition,
  type Usable,
  use,
  useLayoutEffect,
  useState,
  ViewTransition,
} from "react";

function Resolved<T extends ReactNode>({ promise }: { promise: Usable<T> }) {
  return use(promise);
}

/**
 * Streams a deferred RSC payload (or any promise) in under a fallback, and
 * keeps it on screen while mutations reconcile it.
 *
 * The route loader forwards the `renderServerComponent(...)` promise WITHOUT
 * awaiting it, so navigation settles immediately and the fragment streams in
 * under `fallback`.
 *
 * A new `promise` is adopted inside a transition, never rendered directly.
 * Reconciling a mutation re-runs the loader, which yields a fresh unresolved
 * promise; handing that straight to `use()` would re-suspend the boundary —
 * the fallback flashes and the client islands inside remount, losing their
 * optimistic state. Adopted in a transition, the resolved content stays up
 * until the new payload is ready.
 *
 * That adoption is also what lets an optimistic update settle in one commit.
 * It is scheduled while the mutation that awaits `useReconcile()` is still
 * pending, so React entangles it with that mutation's transition and commits
 * the optimistic revert together with the fresh payload. `useDeferredValue`
 * cannot replace it: a deferred render is not entangled, so the revert would
 * commit first and show the stale content for a frame.
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
  // Lazy initializer / updater forms: `Usable` admits `Context`, which is
  // callable, so a bare value would be read as an initializer or updater.
  const [shown, setShown] = useState<Usable<T>>(() => promise);

  // A layout effect, not a passive one: the router resolves `invalidate()` from
  // a layout effect of an ancestor, and layout effects run child-first, so this
  // is scheduled before the awaiting mutation can resume and end its transition.
  useLayoutEffect(() => {
    startTransition(() => setShown(() => promise));
  }, [promise]);

  return (
    <Suspense fallback={<ViewTransition>{fallback}</ViewTransition>}>
      <ViewTransition update="none">
        <Resolved promise={shown} />
      </ViewTransition>
    </Suspense>
  );
}
