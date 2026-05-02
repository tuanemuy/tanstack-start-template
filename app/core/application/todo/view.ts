import type { Todo } from "@/core/domain/todo/entity";

export type TodoStatus = "active" | "completed";

export type TodoView = Readonly<{
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
}>;

export function toTodoView(todo: Todo): TodoView {
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
  };
}
