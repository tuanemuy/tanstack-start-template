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
import { TODO_TITLE_MAX_LENGTH } from "../schema";
import { changeTodoStatusFn, deleteTodoFn, renameTodoFn } from "./action";

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
  const rename = useServerFn(renameTodoFn);

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<SerializedError | null>(null);
  const [optimisticCompleted, setOptimisticCompleted] = useOptimistic(
    todo.status === "completed",
    (_current, next: boolean) => next,
  );
  const [optimisticTitle, setOptimisticTitle] = useOptimistic(
    todo.title,
    (_current, next: string) => next,
  );

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);

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

  const onStartEdit = () => {
    setDraft(todo.title);
    setIsEditing(true);
  };

  const onCancelEdit = () => {
    setDraft(todo.title);
    setIsEditing(false);
    setError(null);
  };

  const onSubmitEdit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === todo.title) {
      setIsEditing(false);
      return;
    }
    startTransition(async () => {
      setOptimisticTitle(trimmed);
      try {
        await rename({ data: { id: todo.id, title: trimmed } });
        await router.invalidate();
        setError(null);
        setIsEditing(false);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  const titleFieldErrors =
    error?.kind === "validation" ? error.fieldErrors?.title : undefined;

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={optimisticCompleted}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={isPending || isEditing}
        />
        {isEditing ? (
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmitEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit();
              }
            }}
            disabled={isPending}
            maxLength={TODO_TITLE_MAX_LENGTH}
            aria-invalid={titleFieldErrors !== undefined}
            // biome-ignore lint/a11y/noAutofocus: focus inline-edit field on open
            autoFocus
          />
        ) : (
          <span
            style={{
              textDecoration: optimisticCompleted ? "line-through" : "none",
            }}
          >
            {optimisticTitle}
          </span>
        )}
      </label>
      {isEditing ? (
        <>
          <button type="button" onClick={onSubmitEdit} disabled={isPending}>
            保存
          </button>
          <button type="button" onClick={onCancelEdit} disabled={isPending}>
            キャンセル
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onStartEdit} disabled={isPending}>
            編集
          </button>
          <button type="button" onClick={onDelete} disabled={isPending}>
            削除
          </button>
        </>
      )}
      {titleFieldErrors !== undefined && titleFieldErrors.length > 0 ? (
        <span role="alert">{titleFieldErrors[0]}</span>
      ) : error !== null && titleFieldErrors === undefined ? (
        <span role="alert">{todoErrorMessage(error)}</span>
      ) : null}
    </li>
  );
}
