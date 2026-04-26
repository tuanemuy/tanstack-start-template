import { createServerFn } from "@tanstack/react-start";
import { getContainer } from "@/core/application/di/server";
import { changeTodoStatus } from "@/core/application/todo/changeTodoStatus";
import { createTodo } from "@/core/application/todo/createTodo";
import { deleteTodo } from "@/core/application/todo/deleteTodo";
import { withErrorResponse } from "@/core/presentation/errorResponse";
import { createValidator } from "@/core/presentation/validator";
import {
  changeTodoStatusSchema,
  createTodoSchema,
  deleteTodoSchema,
} from "./schema";

// `createServerFn(...).handler(...)` already runs server-only, so we invoke
// usecases directly from the handler. `withErrorResponse` wraps any thrown
// value into the `AppServerError` wire envelope so the client can decode it
// uniformly via `extractSerializedError`.

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(createTodoSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      createTodo({ container: await getContainer(), input: data }),
    ),
  );

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(changeTodoStatusSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      changeTodoStatus({ container: await getContainer(), input: data }),
    ),
  );

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(deleteTodoSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      deleteTodo({ container: await getContainer(), input: data }),
    ),
  );
