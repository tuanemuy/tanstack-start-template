import { createServerOnlyFn } from "@tanstack/react-start";
import { getContainer } from "@/core/application/di/server";
import { changeTodoStatus } from "@/core/application/todo/changeTodoStatus";
import { createTodo } from "@/core/application/todo/createTodo";
import { deleteTodo } from "@/core/application/todo/deleteTodo";
import { withErrorResponse } from "@/core/presentation/errorResponse";

export type CreateTodoWireInput = {
  title: string;
};

export type ChangeTodoStatusWireInput = {
  id: string;
  status: "active" | "completed";
};

export type DeleteTodoWireInput = {
  id: string;
};

export const createTodoHandler = createServerOnlyFn(
  async (data: CreateTodoWireInput) =>
    withErrorResponse(async () =>
      createTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
);

export const changeTodoStatusHandler = createServerOnlyFn(
  async (data: ChangeTodoStatusWireInput) =>
    withErrorResponse(async () =>
      changeTodoStatus({
        container: await getContainer(),
        input: data,
      }),
    ),
);

export const deleteTodoHandler = createServerOnlyFn(
  async (data: DeleteTodoWireInput) =>
    withErrorResponse(async () =>
      deleteTodo({
        container: await getContainer(),
        input: data,
      }),
    ),
);
