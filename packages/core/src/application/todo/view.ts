import type { Todo } from "@repo/core/domain/todo/entity";

export type TodoStatus = "active" | "completed";

/**
 * Outbound DTO. Every field is a primitive (or literal union), never a branded
 * value object — branded types widen to their primitive for free, so projection
 * stays cast-free. The reverse (primitive → domain) is not a cast either: feed
 * external input through the value object's `create()`. Reference shape for new
 * `*View` types.
 */
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
