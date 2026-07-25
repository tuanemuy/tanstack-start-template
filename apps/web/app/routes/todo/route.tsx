import { createFileRoute } from "@tanstack/react-router";
import { TodoShell } from "@/components/todo/TodoShell";

export const Route = createFileRoute("/todo")({
  component: TodoShell,
});
