import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Generic, route-level navigation pending UI.
 *
 * Wired as the router's `defaultPendingComponent`: shown while a route whose
 * loader genuinely blocks resolves (past `defaultPendingMs`). Routes that
 * stream their own content via `<Suspense>` (e.g. `/todo`) settle their loader
 * instantly and never trigger this — they rely on a per-fragment skeleton
 * instead.
 *
 * `role="status"` + `aria-live="polite"` + the sr-only label give one polite
 * announcement for the whole region; the bars are `aria-hidden` via `Skeleton`.
 */
export function RoutePendingFallback() {
  return (
    <div role="status" aria-live="polite" className="space-y-4 p-4">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-full max-w-lg" />
    </div>
  );
}
