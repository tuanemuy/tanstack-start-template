"use client";

import { useServerFn } from "@tanstack/react-start";
import type { TodoView } from "@/core/application/todo/view";
import { displayError } from "@/core/presentation/errorDisplay";
import type { SerializedError } from "@/core/presentation/errorResponse";
import { useServerAction } from "@/core/presentation/useServerAction";
import { changeTodoStatusFn, deleteTodoFn } from "./actions";

type Props = {
  todo: TodoView;
};

function todoErrorMessage(error: SerializedError): string {
  if (error.kind === "notFound") return "このTodoは既に削除されています";
  return displayError(error);
}

export function TodoItem({ todo }: Props) {
  const changeStatus = useServerAction(useServerFn(changeTodoStatusFn));
  const remove = useServerAction(useServerFn(deleteTodoFn));
  const isPending = changeStatus.isPending || remove.isPending;
  const error = changeStatus.lastError ?? remove.lastError;

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={(event) =>
            changeStatus.run({
              data: {
                id: todo.id,
                status: event.target.checked ? "completed" : "active",
              },
            })
          }
          disabled={isPending}
        />
        <span
          style={{
            textDecoration: todo.completed ? "line-through" : "none",
          }}
        >
          {todo.title}
        </span>
      </label>
      <button
        type="button"
        onClick={() => remove.run({ data: { id: todo.id } })}
        disabled={isPending}
      >
        削除
      </button>
      {error !== null ? (
        <span role="alert">{todoErrorMessage(error)}</span>
      ) : null}
    </li>
  );
}
