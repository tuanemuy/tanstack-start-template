import type { Todo } from "@/core/domain/todo/entity";

/**
 * Application-layer projection of the `Todo` aggregate.
 *
 * Collapses the `active | completed` discriminated union into a boolean
 * `completed` field and unbrand value-object types so server functions can
 * serialize the result without the presentation layer needing to know about
 * domain branding.
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
