import { createServerFn } from "@tanstack/react-start";
import { getContainer } from "@/core/application/di/server";
import {
  type ChangeTodoStatusInput,
  changeTodoStatus,
} from "@/core/application/todo/changeTodoStatus";
import {
  type CreateTodoInput,
  createTodo,
} from "@/core/application/todo/createTodo";
import {
  type DeleteTodoInput,
  deleteTodo,
} from "@/core/application/todo/deleteTodo";
import { withErrorResponse } from "@/core/presentation/errorResponse.server";

/**
 * The `.inputValidator` step here is a typed pass-through — runtime input
 * validation lives at the application-layer boundary (see the per-usecase
 * Zod schemas), so callers get a uniform `ValidationError` regardless of
 * whether they enter via a server function, a route loader, or a test.
 */

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator((data: CreateTodoInput) => data)
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      createTodo({ container: await getContainer(), input: data }),
    ),
  );

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator((data: ChangeTodoStatusInput) => data)
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      changeTodoStatus({ container: await getContainer(), input: data }),
    ),
  );

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator((data: DeleteTodoInput) => data)
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      deleteTodo({ container: await getContainer(), input: data }),
    ),
  );
