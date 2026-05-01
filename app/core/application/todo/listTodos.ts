import { z } from "zod";
import type { Container } from "@/core/application/di/server";
import type { Pagination } from "@/core/domain/common/pagination";
import { ValidationError, zodIssuesToFieldErrors } from "../errors";
import { type TodoView, toTodoView } from "./view";

export type ListTodosInput = Pagination;

export type ListTodosOutput = {
  todos: TodoView[];
  count: number;
};

const DEFAULT_PAGINATION: Pagination = { page: 1, limit: 20 };

// Defensive re-validation at the application boundary: this usecase is also
// invoked from the RSC loader path, where no `createServerFn` validator runs.
const paginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(200),
});

export async function listTodos({
  container,
  input,
}: {
  container: Container;
  input?: ListTodosInput;
}): Promise<ListTodosOutput> {
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
      "INVALID_INPUT",
      "Invalid pagination input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
  }
  return parsed.data;
}
