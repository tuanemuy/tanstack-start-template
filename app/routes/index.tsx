import { createFileRoute } from "@tanstack/react-router";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";
import { defineServerFn } from "@/core/presentation/serverFn";

const renderTodoList = defineServerFn().handler(async () => {
  const { TodoList } = await import("@/components/todo/TodoList");
  return renderServerComponent(<TodoList />);
});

export const Route = createFileRoute("/")({
  staleTime: 0,
  loader: async () => ({ TodoList: await renderTodoList() }),
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
