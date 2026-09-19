import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useDeferredValue, ViewTransition } from "react";
import { TodoListSkeleton } from "@/components/todo/TodoListSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { buildHead } from "@/presentation/head";
import { paginationSearchSchema } from "@/presentation/pagination";
import { renderTodoList } from "./-action";

export const Route = createFileRoute("/todo/")({
  // This loader returns an unresolved `renderServerComponent(...)` promise that
  // the Suspense boundary below resolves. With `staleTime: 0` the loader re-runs
  // on every navigation, so a revisit yields a fresh promise that re-suspends —
  // the cached list flashes back to the skeleton. Freshness is instead guaranteed
  // by the explicit `router.invalidate()` each mutation runs, so cache the
  // resolved payload in prod and keep `0` only in DEV for HMR.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  validateSearch: (search) => paginationSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    // `TodoList` is a still-unresolved promise; forward it (don't await) so the
    // list streams in under the Suspense fallback below.
    const { TodoList } = await renderTodoList({ data: deps });
    return { TodoList };
  },
  head: ({ match }) => {
    const config = match.context?.config;
    if (!config) return {};
    const { meta, links } = buildHead(config, { path: "/todo" });
    return { meta, links };
  },
  component: TodoPage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function TodoPage() {
  const { TodoList } = Route.useLoaderData();
  // `router.invalidate()` makes the loader hand back a fresh, still-unresolved
  // promise. Fed straight to `use()`, it re-suspends on every mutation: the
  // skeleton flashes and `TodoBoard` remounts, dropping its optimistic state.
  // Deferring keeps the resolved list on screen until the new payload lands.
  const deferredTodoList = useDeferredValue(TodoList);
  return (
    <Suspense
      fallback={
        <ViewTransition>
          <TodoListSkeleton />
        </ViewTransition>
      }
    >
      {/* `update="none"`: animate only the skeleton → list reveal. Left on, every
          mutation would cross-fade the whole list and hold the next commit back
          until the animation ends. */}
      <ViewTransition update="none">
        <Deferred promise={deferredTodoList} />
      </ViewTransition>
    </Suspense>
  );
}
