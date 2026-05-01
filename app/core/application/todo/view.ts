import type { Todo } from "@/core/domain/todo/entity";

/**
 * Cross-boundary projection of the `Todo` aggregate. Collapses the
 * discriminated union into a boolean and unbrands value-object types.
 */
export type TodoView = Readonly<{
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export function toTodoView(todo: Todo): TodoView {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.status === "completed",
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}
