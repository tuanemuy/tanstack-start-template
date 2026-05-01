import type { Container } from "@/core/application/di/server";
import type { Pagination } from "@/core/domain/common/pagination";
import { type TodoView, toTodoView } from "./view";

export type ListTodosInput = Pagination;

export type ListTodosOutput = {
  todos: TodoView[];
  count: number;
};

const DEFAULT_PAGINATION: Pagination = { page: 1, limit: 20 };

export async function listTodos({
  container,
  input,
}: {
  container: Container;
  input?: ListTodosInput;
}): Promise<ListTodosOutput> {
  const pagination = input ?? DEFAULT_PAGINATION;

  const { items, count } = await container.unitOfWorkProvider.run(
    ({ todoRepository }) => todoRepository.findPage(pagination),
  );

  return { todos: items.map(toTodoView), count };
}
