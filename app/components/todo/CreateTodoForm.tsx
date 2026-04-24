"use client";

import { useServerFn } from "@tanstack/react-start";
import { type SubmitEvent, useState } from "react";
import { TodoTitle } from "@/core/domain/todo/valueObject";
import { displayError } from "@/core/presentation/errorDisplay";
import { useServerAction } from "@/core/presentation/useServerAction";
import { createTodoFn } from "./actions";

export function CreateTodoForm() {
  const [title, setTitle] = useState("");

  const { run, isPending, lastError, clearLastError } = useServerAction(
    useServerFn(createTodoFn),
    {
      onSuccess: () => {
        setTitle("");
      },
    },
  );

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    run({ data: { title: value } });
  };

  // Prefer field-level messages when the server returned a structured
  // `ValidationError.fieldErrors`; fall back to the consolidated message
  // for every other error kind (business / system / conflict / etc.).
  const titleFieldErrors =
    lastError?.kind === "validation" ? lastError.fieldErrors?.title : undefined;
  const summaryMessage =
    lastError !== null && titleFieldErrors === undefined
      ? displayError(lastError)
      : null;

  return (
    <form onSubmit={onSubmit}>
      <label>
        タイトル
        <input
          type="text"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (lastError) clearLastError();
          }}
          disabled={isPending}
          maxLength={TodoTitle.maxLength}
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
