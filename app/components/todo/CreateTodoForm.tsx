"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState, useTransition } from "react";
import { TodoTitle } from "@/core/domain/todo/valueObject";
import { displayError } from "@/lib/errorDisplay";
import { createTodoFn } from "./actions";

export function CreateTodoForm() {
  const router = useRouter();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;

    startTransition(async () => {
      try {
        await createTodo({ data: { title: value } });
        setTitle("");
        setErrorMessage(null);
        await router.invalidate();
      } catch (error) {
        setErrorMessage(displayError(error));
      }
    });
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
