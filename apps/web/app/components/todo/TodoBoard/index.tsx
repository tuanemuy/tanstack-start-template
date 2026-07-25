"use client";

import type { TodoView } from "@repo/core/application/todo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { CreateTodoForm } from "../CreateTodoForm";
import { TodoItem } from "../TodoItem";
import { deleteTodoFn } from "./action";

/**
 * Client owner of the todo list.
 *
 * The route loader still owns the RSC payload (server-fetched `todos` arrive
 * as props). This component seeds a client-side `useOptimistic` list on top so
 * that add/remove — which change list membership and therefore can't be done
 * with an item-local `useOptimistic` — reflect instantly.
 *
 * The owner runs the server function for every list-membership change: add is
 * dispatched from `CreateTodoForm`'s action (the form lives outside the list,
 * so it survives the round trip), but delete must run here. A leaf can't own
 * its own delete because the optimistic removal unmounts that leaf before the
 * request settles, which would discard its error UI. In-item mutations
 * (`completed` toggle, inline rename) stay in `TodoItem` — they don't change
 * membership and the leaf survives them.
 *
 * Each mutation calls `router.invalidate()` once it resolves; the loader
 * re-renders with fresh data and the optimistic list re-bases onto it. A
 * failed mutation reverts automatically.
 *
 * Loading is split by phase: the initial/streaming load is owned by
 * `TodoListSkeleton` (the route's `<Suspense>` fallback), which this component
 * replaces wholesale once the RSC payload arrives. The `useOptimistic` /
 * `aria-busy` here only cover post-mount mutations.
 */
type OptimisticAction =
  | { type: "add"; todo: TodoView }
  | { type: "remove"; id: string };

function applyAction(
  current: TodoView[],
  action: OptimisticAction,
): TodoView[] {
  switch (action.type) {
    case "add":
      return [action.todo, ...current];
    case "remove":
      return current.filter((todo) => todo.id !== action.id);
  }
}

type Props = {
  todos: TodoView[];
  count: number;
};

export function TodoBoard({ todos, count }: Props) {
  const router = useRouter();
  const remove = useServerFn(deleteTodoFn);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<SerializedError | null>(null);
  const [optimisticTodos, applyOptimistic] = useOptimistic(todos, applyAction);
  // `count` is the total across pages; reflect the pending add/remove as a
  // delta against the current page so the header doesn't lag the list.
  const displayCount = count + (optimisticTodos.length - todos.length);

  const onDelete = (id: string) => {
    startTransition(async () => {
      applyOptimistic({ type: "remove", id });
      try {
        await remove({ data: { id } });
        await router.invalidate();
        setError(null);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  return (
    <section aria-busy={isPending}>
      <h1>Todos ({displayCount})</h1>
      <CreateTodoForm
        onOptimisticAdd={(todo) => applyOptimistic({ type: "add", todo })}
      />
      {error !== null ? (
        <p className="text-red-500" aria-live="polite">
          {displayError(error)}
        </p>
      ) : null}
      {optimisticTodos.length === 0 ? (
        <p>まだ Todo がありません。</p>
      ) : (
        <ul>
          {optimisticTodos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onDelete={() => onDelete(todo.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
