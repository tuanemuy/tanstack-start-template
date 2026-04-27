import { z } from "zod";
import type { Pagination } from "@/core/domain/common/pagination";
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

// Defensive re-validation at the application boundary: this usecase is also
// invoked from the RSC loader path (no `createServerFn` validator runs there),
// so we cannot trust the caller's shape. Kept inline rather than in
// `domain/common/pagination.ts` to keep the domain layer free of runtime
// validators.
const paginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(200),
});

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
