import {
  type Pagination,
  paginationSchema,
} from "@/core/domain/common/pagination";
import { ValidationError, ValidationErrorCode } from "../error";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./dto";

export type ListTodosInput = Pagination;

export type ListTodosOutput = {
  todos: TodoView[];
  count: number;
};

const DEFAULT_PAGINATION: Pagination = { page: 1, limit: 20 };

/**
 * Return a paginated snapshot of todos. Defaults to page 1, limit 20 when
 * called with `input: undefined` so the simplest "just list them" callers
 * can stay terse.
 */
export async function listTodos({
  container,
  input,
}: ServiceArgs<ListTodosInput | undefined>): Promise<ListTodosOutput> {
  const pagination = parseInput(input);

  const { items, count } = await container.unitOfWorkProvider.run(
    ({ todoRepository }) => todoRepository.findPage(pagination),
    { mode: "readonly" },
  );

  return { todos: items.map(toTodoView), count };
}

/**
 * Validate the (optional) pagination input. Missing input falls back to the
 * default page; malformed input — e.g. `page: 0` or `limit: 500` — raises
 * `ValidationError(InvalidInput)` so the presentation layer can surface a
 * 400 rather than propagating a cryptic DB offset error.
 */
function parseInput(input: ListTodosInput | undefined): Pagination {
  if (input === undefined) return DEFAULT_PAGINATION;
  const parsed = paginationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      ValidationErrorCode.InvalidInput,
      "Invalid pagination input",
      parsed.error,
    );
  }
  return parsed.data;
}
