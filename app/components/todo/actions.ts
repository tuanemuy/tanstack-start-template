import { defineServerFn } from "@/core/presentation/serverFn";
import { validateInput } from "@/core/presentation/validator";
import {
  changeTodoStatusSchema,
  createTodoSchema,
  deleteTodoSchema,
} from "./schema";

// Server-only modules (`di/server`, usecases) are dynamic-imported inside
// each handler so the static graph from this file stays client-safe — client
// components import the bound server functions to drive RPC.
export const createTodoFn = defineServerFn({ method: "POST" })
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) => {
    const [{ getContainer }, { createTodo }] = await Promise.all([
      import("@/core/application/di/server"),
      import("@/core/application/todo/createTodo"),
    ]);
    return createTodo({ container: await getContainer(), input: data });
  });

export const changeTodoStatusFn = defineServerFn({ method: "POST" })
  .inputValidator(validateInput(changeTodoStatusSchema))
  .handler(async ({ data }) => {
    const [{ getContainer }, { changeTodoStatus }] = await Promise.all([
      import("@/core/application/di/server"),
      import("@/core/application/todo/changeTodoStatus"),
    ]);
    return changeTodoStatus({ container: await getContainer(), input: data });
  });

export const deleteTodoFn = defineServerFn({ method: "POST" })
  .inputValidator(validateInput(deleteTodoSchema))
  .handler(async ({ data }) => {
    const [{ getContainer }, { deleteTodo }] = await Promise.all([
      import("@/core/application/di/server"),
      import("@/core/application/todo/deleteTodo"),
    ]);
    return deleteTodo({ container: await getContainer(), input: data });
  });
