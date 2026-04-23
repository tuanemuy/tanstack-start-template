"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { extractSerializedError } from "@/core/application/errorResponse";
import type { TodoView } from "@/core/application/todo/dto";
import { displayError } from "@/lib/errorDisplay";
import { deleteTodoFn, toggleTodoFn } from "./actions";

type Props = {
  todo: TodoView;
};

export function TodoItem({ todo }: Props) {
  const router = useRouter();
  const toggleTodo = useServerFn(toggleTodoFn);
  const deleteTodo = useServerFn(deleteTodoFn);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = (fn: () => Promise<unknown>) => {
    startTransition(async () => {
      try {
        await fn();
        setErrorMessage(null);
        await router.invalidate();
      } catch (error) {
        const serialized = extractSerializedError(error);
        if (serialized.kind === "notFound") {
          setErrorMessage("このTodoは既に削除されています");
        } else {
          setErrorMessage(displayError(error));
        }
      }
    });
  };

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={() => run(() => toggleTodo({ data: { id: todo.id } }))}
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
        onClick={() => run(() => deleteTodo({ data: { id: todo.id } }))}
        disabled={isPending}
      >
        削除
      </button>
      {errorMessage ? <span role="alert">{errorMessage}</span> : null}
    </li>
  );
}
