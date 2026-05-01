import { createServerFn } from "@tanstack/react-start";
import { getContainer } from "@/core/application/di/server";
import { changeTodoStatus } from "@/core/application/todo/changeTodoStatus";
import { createTodo } from "@/core/application/todo/createTodo";
import { deleteTodo } from "@/core/application/todo/deleteTodo";
import { withErrorResponse } from "@/core/presentation/errorResponse.server";
import { validateInput } from "@/core/presentation/validator";
import {
  changeTodoStatusSchema,
  createTodoSchema,
  deleteTodoSchema,
} from "./schema";

/**
 * `inputValidator` runs in both client and server bundles. `validateInput`
 * is intentionally a shape-only check (Zod over plain JSON) and depends on
 * no application/domain modules, so it's safe to ship to the client.
 * Domain invariants are reasserted by the value-object factories the
 * usecase reaches through (`TodoTitle.create` etc).
 */

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      createTodo({ container: await getContainer(), input: data }),
    ),
  );

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator(validateInput(changeTodoStatusSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      changeTodoStatus({ container: await getContainer(), input: data }),
    ),
  );

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(validateInput(deleteTodoSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      deleteTodo({ container: await getContainer(), input: data }),
    ),
  );
