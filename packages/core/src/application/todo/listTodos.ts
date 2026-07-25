import type { Pagination } from "@repo/core/domain/common/pagination";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type ListTodosInput = Pagination;

export type ListTodosOutput = {
  todos: TodoView[];
  count: number;
};

export async function listTodos({
  container,
  input,
}: ServiceArgs<ListTodosInput>): Promise<ListTodosOutput> {
  const { items, count } = await container.unitOfWorkProvider.run(
    ({ todoRepository }) => todoRepository.findPage(input),
  );

  return { todos: items.map(toTodoView), count };
}
