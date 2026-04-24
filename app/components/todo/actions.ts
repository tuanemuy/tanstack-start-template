import { createServerFn } from "@tanstack/react-start";
import { createValidator } from "@/core/presentation/validator";
import {
  changeTodoStatusHandler,
  createTodoHandler,
  deleteTodoHandler,
} from "./actionHandlers";
import {
  changeTodoStatusSchema,
  createTodoSchema,
  deleteTodoSchema,
} from "./schema";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(createTodoSchema))
  .handler(({ data }) => createTodoHandler(data));

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(changeTodoStatusSchema))
  .handler(({ data }) => changeTodoStatusHandler(data));

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(createValidator(deleteTodoSchema))
  .handler(({ data }) => deleteTodoHandler(data));
