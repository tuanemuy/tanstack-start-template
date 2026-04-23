import "@tanstack/react-start/server-only";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getContainer } from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";
import { deleteTodo } from "@/core/application/todo/deleteTodo";
import { toggleTodo } from "@/core/application/todo/toggleTodo";
import { TodoTitle } from "@/core/domain/todo/valueObject";
import { withErrorResponse } from "@/core/presentation/errorResponse";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({ title: z.string().trim().min(1).max(TodoTitle.maxLength) }),
  )
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      createTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
  );

export const toggleTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      toggleTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
  );

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      deleteTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
  );
