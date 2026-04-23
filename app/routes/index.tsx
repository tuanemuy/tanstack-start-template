import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { TodoList } from "@/components/todo/TodoList";
import { withErrorResponse } from "@/core/application/errorResponse";
import { sanitizeRouteError } from "@/lib/errorDisplay";

const renderTodoList = createServerFn({ method: "GET" }).handler(async () =>
  withErrorResponse(async () => {
    const Rendered = await renderServerComponent(<TodoList />);
    return { Rendered };
  }),
);

export const Route = createFileRoute("/")({
  loader: async () => {
    const { Rendered } = await renderTodoList();
    return { TodoList: Rendered };
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
