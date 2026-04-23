import { createFileRoute } from "@tanstack/react-router";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { TodoList } from "@/components/todo/TodoList";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";

export const Route = createFileRoute("/")({
  loader: async () => {
    const Rendered = await renderServerComponent(<TodoList />);
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
