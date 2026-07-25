"use client";

import type { TodoView } from "@repo/core/application/todo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useId, useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { TODO_TITLE_MAX_LENGTH } from "../schema";
import { changeTodoStatusFn, renameTodoFn } from "./action";

type Props = {
  todo: TodoView;
  // Delete is a list-membership change, so the owner (TodoBoard) runs the
  // server function and owns the optimistic removal + its error display. The
  // leaf only signals intent — it can't keep an error visible because the
  // optimistic removal unmounts it before the request settles.
  onDelete: () => void;
};

function todoErrorMessage(error: SerializedError): string {
  if (error.kind === "notFound") return "このTodoは既に削除されています";
  return displayError(error);
}

export function TodoItem({ todo, onDelete }: Props) {
  const router = useRouter();
  const changeStatus = useServerFn(changeTodoStatusFn);
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
    // Close the editor and show the new title immediately; the optimistic
    // title reverts (and the error surfaces) if the rename throws.
    setIsEditing(false);
    startTransition(async () => {
      setOptimisticTitle(trimmed);
      try {
        await rename({ data: { id: todo.id, title: trimmed } });
        await router.invalidate();
        setError(null);
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
          <span className="sr-only">{optimisticTitle}</span>
        ) : (
          <span
            className={optimisticCompleted ? "line-through" : "no-underline"}
          >
            {optimisticTitle}
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
