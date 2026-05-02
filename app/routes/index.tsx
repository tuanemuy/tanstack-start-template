import { createFileRoute } from "@tanstack/react-router";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";
import { buildHead } from "@/core/presentation/head";
import { defineServerFn } from "@/core/presentation/serverFn";
import { loadAppContext } from "./__root";

const renderTodoList = defineServerFn().handler(async () => {
  const { TodoList } = await import("@/components/todo/TodoList");
  return renderServerComponent(<TodoList />);
});

export const Route = createFileRoute("/")({
  staleTime: 0,
  loader: async () => {
    const [{ config }, TodoList] = await Promise.all([
      loadAppContext(),
      renderTodoList(),
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
