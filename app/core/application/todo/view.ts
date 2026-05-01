import type { Todo } from "@/core/domain/todo/entity";

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
