import { serverAction } from "@/core/presentation/serverAction";
import { createTodoSchema } from "../schema";

export const createTodoFn = serverAction(
  createTodoSchema,
  () => import("@/core/application/todo/createTodo"),
  ({ data, container }, { createTodo }) =>
    createTodo({ container, input: data }),
);
