import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/todo")({
  component: TodoLayout,
});

function TodoLayout() {
  return (
    <div>
      <header>
        <nav>
          <Link to="/">← Home</Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
