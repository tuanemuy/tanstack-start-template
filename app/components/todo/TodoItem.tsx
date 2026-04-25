"use client";

import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { TodoView } from "@/core/application/todo/view";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  type ErrorHandlers,
  useServerAction,
} from "@/core/presentation/useServerAction";
import { changeTodoStatusFn, deleteTodoFn } from "./actions";

type Props = {
  todo: TodoView;
};

export function TodoItem({ todo }: Props) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onError: ErrorHandlers = {
    notFound: () => setErrorMessage("このTodoは既に削除されています"),
    default: (error) => setErrorMessage(displayError(error)),
  };
  const onSuccess = () => setErrorMessage(null);

  const changeStatus = useServerAction(useServerFn(changeTodoStatusFn), {
    onError,
    onSuccess,
  });
  const remove = useServerAction(useServerFn(deleteTodoFn), {
    onError,
    onSuccess,
  });
  const isPending = changeStatus.isPending || remove.isPending;

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
      {errorMessage ? <span role="alert">{errorMessage}</span> : null}
    </li>
  );
}
