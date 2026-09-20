"use client";

import type { TodoView } from "@repo/core/application/todo/view";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useRef, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { newId } from "@/presentation/newId";
import { useReconcile } from "@/presentation/reconcile";
import { TODO_TITLE_MAX_LENGTH } from "../schema";
import { createTodoFn } from "./action";

type FormState = { error: SerializedError | null };

const initialState: FormState = { error: null };

type Props = {
  // Dispatched into the parent's optimistic list so the new row shows before
  // the server confirms; reverts automatically if the action throws.
  onOptimisticAdd: (todo: TodoView) => void;
};

export function CreateTodoForm({ onOptimisticAdd }: Props) {
  const reconcile = useReconcile();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");
  const titleId = useId();
  const titleErrorId = useId();
  const summaryErrorId = useId();
  // The create whose outcome is not yet known to be final. A failed attempt may
  // have committed server-side with only its response lost, so resubmitting the
  // same title resends the same id and `createTodo` answers it as a replay
  // instead of adding a second todo.
  const attempt = useRef<{ id: string; title: string } | null>(null);

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const value = String(formData.get("title") ?? "");
      const trimmed = value.trim();
      if (attempt.current?.title !== trimmed) {
        attempt.current = { id: newId(), title: trimmed };
      }
      const { id } = attempt.current;
      try {
        // Shown until `reconcile()` brings the server's record. Both carry the
        // same id, so the row keeps its `key` and is not remounted.
        const now = new Date().toISOString();
        onOptimisticAdd({
          id,
          title: trimmed,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await createTodo({ data: { id, title: value } });
        attempt.current = null;
        setTitle("");
        await reconcile();
        return { error: null };
      } catch (error) {
        const serialized = extractSerializedError(error);
        // The id belongs to a different todo; resending it can never succeed.
        if (
          serialized.kind === "conflict" &&
          serialized.code === "TODO_ID_CONFLICT"
        ) {
          attempt.current = null;
        }
        return { error: serialized };
      }
    },
    initialState,
  );

  const titleFieldErrors =
    state.error?.kind === "validation"
      ? state.error.fieldErrors?.title
      : undefined;
  const titleErrorMessage =
    titleFieldErrors !== undefined && titleFieldErrors.length > 0
      ? titleFieldErrors[0]
      : "";
  const summaryMessage =
    state.error !== null && titleFieldErrors === undefined
      ? displayError(state.error)
      : "";

  return (
    <form action={formAction}>
      <label htmlFor={titleId}>タイトル</label>
      <input
        id={titleId}
        name="title"
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={isPending}
        maxLength={TODO_TITLE_MAX_LENGTH}
        required
        aria-invalid={titleFieldErrors !== undefined}
        aria-describedby={titleErrorMessage !== "" ? titleErrorId : undefined}
      />
      <p id={titleErrorId} className="text-red-500" aria-live="polite">
        {titleErrorMessage}
      </p>
      <button type="submit" disabled={isPending || title.trim().length === 0}>
        {isPending ? "作成中..." : "追加"}
      </button>
      <p id={summaryErrorId} className="text-red-500" aria-live="polite">
        {summaryMessage}
      </p>
    </form>
  );
}
