import {
  type Pagination,
  paginationSchema,
} from "@/core/domain/common/pagination";
import {
  ValidationError,
  ValidationErrorCode,
  zodIssuesToFieldErrors,
} from "../errors";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type ListTodosInput = Pagination;

export type ListTodosOutput = {
  todos: TodoView[];
  count: number;
};

const DEFAULT_PAGINATION: Pagination = { page: 1, limit: 20 };

/**
 * Return a paginated snapshot of todos. Defaults to page 1, limit 20 when
 * called with `input: undefined`.
 */
export async function listTodos({
  container,
  input,
}: ServiceArgs<ListTodosInput | undefined>): Promise<ListTodosOutput> {
  const pagination = parseInput(input);

  const { items, count } = await container.unitOfWorkProvider.run(
    ({ todoRepository }) => todoRepository.findPage(pagination),
  );

  return { todos: items.map(toTodoView), count };
}

function parseInput(input: ListTodosInput | undefined): Pagination {
  if (input === undefined) return DEFAULT_PAGINATION;
  const parsed = paginationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      ValidationErrorCode.InvalidInput,
      "Invalid pagination input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
  }
  return parsed.data;
}
