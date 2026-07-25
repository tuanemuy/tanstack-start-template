import { Skeleton } from "@/components/ui/Skeleton";

const PLACEHOLDER_ROWS = ["a", "b", "c", "d", "e"];

function TodoItemSkeleton() {
  return (
    <li className="flex items-center gap-2 py-2">
      <Skeleton className="size-4 rounded-sm" />
      <Skeleton className="h-4 max-w-96 flex-1" />
      <Skeleton className="h-8 w-12" />
      <Skeleton className="h-8 w-12" />
    </li>
  );
}

/**
 * Suspense fallback for `/todo`'s deferred RSC list.
 *
 * Mirrors `TodoBoard`'s DOM (`h1` + create form + `ul > li`) so the streamed
 * content swaps in without layout shift. `role="status"` + `aria-busy` + the
 * sr-only label give one polite announcement for the whole loading region;
 * the child bars are `aria-hidden` (see `Skeleton`). Animation is disabled
 * under `prefers-reduced-motion`.
 */
export function TodoListSkeleton() {
  return (
    <section role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Todo を読み込み中</span>
      <Skeleton className="h-8 w-48" />
      <div className="mt-4 flex items-center gap-2">
        <Skeleton className="h-9 max-w-80 flex-1" />
        <Skeleton className="h-9 w-16" />
      </div>
      <ul className="mt-4">
        {PLACEHOLDER_ROWS.map((row) => (
          <TodoItemSkeleton key={row} />
        ))}
      </ul>
    </section>
  );
}
