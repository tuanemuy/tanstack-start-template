import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";

const loadTodoListRouteData = createServerFn({ method: "GET" }).handler(
  async () => {
    const { TodoList } = await import("@/components/todo/TodoList");
    const Rendered = await renderServerComponent(<TodoList />);
    return { TodoList: Rendered };
  },
);

export const Route = createFileRoute("/")({
  // `staleTime: 0` makes the loader re-run on every navigation so the
  // RSC payload always reflects the latest server state. The TodoList
  // server component owns its own `cache()`-based request dedupe, so
  // re-running the loader is cheap within a single navigation. If we
  // later want to keep the payload across back/forward navigation, bump
  // `staleTime` or set `shouldReload: false` explicitly.
  staleTime: 0,
  loader: () => loadTodoListRouteData(),
  component: HomePage,
  // Caught first, before bubbling up to `__root.tsx`'s errorComponent.
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
