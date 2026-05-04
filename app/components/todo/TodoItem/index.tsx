"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useId, useOptimistic, useState, useTransition } from "react";
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

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);

  const checkboxId = useId();
  const titleInputId = useId();
  const errorId = useId();

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
  const errorMessage =
    titleFieldErrors !== undefined && titleFieldErrors.length > 0
      ? titleFieldErrors[0]
      : error !== null && titleFieldErrors === undefined
        ? todoErrorMessage(error)
        : "";

  return (
    <li>
      <input
        id={checkboxId}
        type="checkbox"
        checked={optimisticCompleted}
        onChange={(event) => onToggle(event.target.checked)}
        disabled={isPending || isEditing}
      />
      <label htmlFor={checkboxId}>
        {isEditing ? (
          <span className="sr-only">{todo.title}</span>
        ) : (
          <span
            className={optimisticCompleted ? "line-through" : "no-underline"}
          >
            {todo.title}
          </span>
        )}
      </label>
      {isEditing ? (
        <>
          <label htmlFor={titleInputId} className="sr-only">
            タイトル
          </label>
          <input
            id={titleInputId}
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
            aria-describedby={errorMessage !== "" ? errorId : undefined}
            // biome-ignore lint/a11y/noAutofocus: focus inline-edit field on open
            autoFocus
          />
        </>
      ) : null}
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
      <span id={errorId} aria-live="polite">
        {errorMessage}
      </span>
    </li>
  );
}
