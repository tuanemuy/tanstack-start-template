"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import type { TodoView } from "@/core/application/todo/view";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/core/presentation/errorResponse";
import { changeTodoStatusFn, deleteTodoFn } from "./actions";

type Props = {
  todo: TodoView;
};

function todoErrorMessage(error: SerializedError): string {
  if (error.kind === "notFound") return "このTodoは既に削除されています";
  return displayError(error);
}

export function TodoItem({ todo }: Props) {
  const router = useRouter();
  const changeStatus = useServerFn(changeTodoStatusFn);
  const remove = useServerFn(deleteTodoFn);

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<SerializedError | null>(null);
  const [optimisticCompleted, setOptimisticCompleted] = useOptimistic(
    todo.completed,
    (_current, next: boolean) => next,
  );

  const onToggle = (checked: boolean) => {
    startTransition(async () => {
      setOptimisticCompleted(checked);
      try {
        await changeStatus({
          data: { id: todo.id, status: checked ? "completed" : "active" },
        });
        await router.invalidate();
        setError(null);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  const onDelete = () => {
    startTransition(async () => {
      try {
        await remove({ data: { id: todo.id } });
        await router.invalidate();
        setError(null);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={optimisticCompleted}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={isPending}
        />
        <span
          style={{
            textDecoration: optimisticCompleted ? "line-through" : "none",
          }}
        >
          {todo.title}
        </span>
      </label>
      <button type="button" onClick={onDelete} disabled={isPending}>
        削除
      </button>
      {error !== null ? (
        <span role="alert">{todoErrorMessage(error)}</span>
      ) : null}
    </li>
  );
}
