import { serverAction } from "@/core/presentation/serverAction";
import {
  changeTodoStatusSchema,
  deleteTodoSchema,
  renameTodoSchema,
} from "../schema";

export const changeTodoStatusFn = serverAction(
  changeTodoStatusSchema,
  () => import("@/core/application/todo/changeTodoStatus"),
  ({ data, container }, { changeTodoStatus }) =>
    changeTodoStatus({ container, input: data }),
);

export const renameTodoFn = serverAction(
  renameTodoSchema,
  () => import("@/core/application/todo/renameTodo"),
  ({ data, container }, { renameTodo }) =>
    renameTodo({ container, input: data }),
);

export const deleteTodoFn = serverAction(
  deleteTodoSchema,
  () => import("@/core/application/todo/deleteTodo"),
  ({ data, container }, { deleteTodo }) =>
    deleteTodo({ container, input: data }),
);
