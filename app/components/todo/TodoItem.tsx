"use client";

import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { TodoView } from "@/core/application/todo/dto";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  type ErrorHandlers,
  useServerAction,
} from "@/core/presentation/useServerAction";
import { deleteTodoFn, toggleTodoFn } from "./actions";

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

  const toggle = useServerAction(useServerFn(toggleTodoFn), {
    onError,
    onSuccess,
  });
  const remove = useServerAction(useServerFn(deleteTodoFn), {
    onError,
    onSuccess,
  });
  const isPending = toggle.isPending || remove.isPending;

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={() => toggle.run({ data: { id: todo.id } })}
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
