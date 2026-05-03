import { createFileRoute } from "@tanstack/react-router";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";
import { buildHead } from "@/core/presentation/head";
import { loadAppContext } from "../__root";
import { paginationSearchSchema, renderTodoList } from "./-action";

export const Route = createFileRoute("/_home/")({
  staleTime: 0,
  validateSearch: (search) => paginationSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [{ config }, TodoList] = await Promise.all([
      loadAppContext(),
      renderTodoList({ data: deps }),
    ]);
    return { config, TodoList };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { meta, links } = buildHead(loaderData.config, { path: "/" });
    return { meta, links };
  },
  component: HomePage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function HomePage() {
  const { TodoList } = Route.useLoaderData();
  return <>{TodoList}</>;
}
