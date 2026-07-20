"use client";

import type { TodoView } from "@repo/core/application/todo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
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
  const router = useRouter();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");
  const titleId = useId();
  const titleErrorId = useId();
  const summaryErrorId = useId();

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const value = String(formData.get("title") ?? "");
      try {
        // Placeholder row shown until `router.invalidate()` replaces it with
        // the server-assigned record; the temp id only has to be unique within
        // the optimistic list, never persisted.
        const now = new Date().toISOString();
        onOptimisticAdd({
          id: `optimistic-${crypto.randomUUID()}`,
          title: value.trim(),
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await createTodo({ data: { title: value } });
        setTitle("");
        await router.invalidate();
        return { error: null };
      } catch (error) {
        return { error: extractSerializedError(error) };
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
