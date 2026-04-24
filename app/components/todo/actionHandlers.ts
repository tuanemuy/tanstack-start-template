import { createServerOnlyFn } from "@tanstack/react-start";
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
import { withErrorResponse } from "@/core/presentation/errorResponse";

export const createTodoHandler = createServerOnlyFn(
  async (data: CreateTodoInput) =>
    withErrorResponse(async () =>
      createTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
);

export const changeTodoStatusHandler = createServerOnlyFn(
  async (data: ChangeTodoStatusInput) =>
    withErrorResponse(async () =>
      changeTodoStatus({
        container: await getContainer(),
        input: data,
      }),
    ),
);

export const deleteTodoHandler = createServerOnlyFn(
  async (data: DeleteTodoInput) =>
    withErrorResponse(async () =>
      deleteTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
);
