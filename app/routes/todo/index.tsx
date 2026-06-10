import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { TodoListSkeleton } from "@/components/todo/TodoListSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";
import { buildHead } from "@/core/presentation/head";
import { paginationSearchSchema } from "@/core/presentation/pagination";
import { renderTodoList } from "./-action";

export const Route = createFileRoute("/todo/")({
  staleTime: 0,
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
  return (
    <Suspense fallback={<TodoListSkeleton />}>
      <Deferred promise={TodoList} />
    </Suspense>
  );
}
