import "@tanstack/react-start/server-only";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getContainer } from "@/core/application/di/server";
import { withErrorResponse } from "@/core/application/errorResponse";
import { createTodo } from "@/core/application/todo/createTodo";
import { deleteTodo } from "@/core/application/todo/deleteTodo";
import { toggleTodo } from "@/core/application/todo/toggleTodo";
import { TodoTitle } from "@/core/domain/todo/valueObject";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({ title: z.string().trim().min(1).max(TodoTitle.maxLength) }),
  )
  .handler(({ data }) =>
    withErrorResponse(() =>
      createTodo({
        container: getContainer(),
        input: data,
      }),
    ),
  );

export const toggleTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) =>
    withErrorResponse(() =>
      toggleTodo({
        container: getContainer(),
        input: data,
      }),
    ),
  );

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) =>
    withErrorResponse(() =>
      deleteTodo({
        container: getContainer(),
        input: data,
      }),
    ),
  );
