"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useState } from "react";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/core/presentation/errorResponse";
import { TODO_TITLE_MAX_LENGTH } from "../schema";
import { createTodoFn } from "./action";

type FormState = { error: SerializedError | null };

const initialState: FormState = { error: null };

export function CreateTodoForm() {
  const router = useRouter();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const value = String(formData.get("title") ?? "").trim();
      if (value.length === 0) return { error: null };
      try {
        await createTodo({ data: { title: value } });
        await router.invalidate();
        setTitle("");
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
  const summaryMessage =
    state.error !== null && titleFieldErrors === undefined
      ? displayError(state.error)
      : null;

  return (
    <form action={formAction}>
      <label>
        タイトル
        <input
          name="title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={isPending}
          maxLength={TODO_TITLE_MAX_LENGTH}
          required
          aria-invalid={titleFieldErrors !== undefined}
        />
      </label>
      {titleFieldErrors !== undefined && titleFieldErrors.length > 0 ? (
        <p className="text-red-500" role="alert">
          {titleFieldErrors[0]}
        </p>
      ) : null}
      <button type="submit" disabled={isPending || title.trim().length === 0}>
        {isPending ? "作成中..." : "追加"}
      </button>
      {summaryMessage !== null ? (
        <p className="text-red-500" role="alert">
          {summaryMessage}
        </p>
      ) : null}
    </form>
  );
}
