"use client";

import { useServerFn } from "@tanstack/react-start";
import { type SubmitEvent, useState } from "react";
import { TodoTitle } from "@/core/domain/todo/valueObject";
import { displayError } from "@/core/presentation/errorDisplay";
import { useServerAction } from "@/core/presentation/useServerAction";
import { createTodoFn } from "./actions";

export function CreateTodoForm() {
  const [title, setTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { run, isPending } = useServerAction(useServerFn(createTodoFn), {
    onSuccess: () => {
      setTitle("");
      setErrorMessage(null);
    },
    onError: {
      default: (error) => setErrorMessage(displayError(error)),
    },
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    run({ data: { title: value } });
  };

  return (
    <form onSubmit={onSubmit}>
      <label>
        タイトル
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={isPending}
          maxLength={TodoTitle.maxLength}
          required
        />
      </label>
      <button type="submit" disabled={isPending || title.trim().length === 0}>
        {isPending ? "作成中..." : "追加"}
      </button>
      {errorMessage ? <p role="alert">{errorMessage}</p> : null}
    </form>
  );
}
