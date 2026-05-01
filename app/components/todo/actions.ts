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
