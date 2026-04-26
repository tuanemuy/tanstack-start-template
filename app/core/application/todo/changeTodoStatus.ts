import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
import {
  ConflictError,
  ConflictErrorCode,
  isConflictError,
  NotFoundError,
  NotFoundErrorCode,
} from "../errors";
import { retry } from "../execution/retry";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type TodoStatusInput = "active" | "completed";

export type ChangeTodoStatusInput = {
  id: string;
  status: TodoStatusInput;
};

export type ChangeTodoStatusOutput = {
  todo: TodoView;
};

const MAX_OCC_ATTEMPTS = 2;

/**
 * Set a todo's status to `active` or `completed`.
 *
 * "Set status to X" is idempotent — re-reading and re-writing on an OCC
 * conflict is safe — so the local retry loop sits inside the usecase
 * rather than surfacing the conflict to the caller. After exhausting the
 * budget we translate the underlying `ConflictError(OptimisticLockFailure)`
 * into one whose message names the attempt count, so operators can tell
 * "concurrent writers, retried" apart from a first-attempt conflict.
 */
export async function changeTodoStatus({
  container,
  input,
}: ServiceArgs<ChangeTodoStatusInput>): Promise<ChangeTodoStatusOutput> {
  const id = TodoId.create(input.id);

  // Capture "now" once per usecase invocation, before the retry loop, so
  // every attempt — and the eventual successful write — agrees on the same
  // timestamp by construction. The application's notion of "this command's
  // instant" should not jitter between OCC retries.
  const now = container.clock.now();

  let attemptsRun = 1;
  try {
    const next = await retry(
      () =>
        container.unitOfWorkProvider.run(
          async ({ todoRepository, collectEvents }) => {
            const current = await todoRepository.findById(id);
            if (!current) {
              throw new NotFoundError(
                NotFoundErrorCode.TodoNotFound,
                `Todo not found: ${id}`,
              );
            }

            const { entity: next, events } = setStatusIfNeeded(
              current,
              input.status,
              now,
            );
            if (events.length === 0) return current;
            await todoRepository.save(next);
            collectEvents(events);
            return next;
          },
        ),
      {
        maxAttempts: MAX_OCC_ATTEMPTS,
        shouldRetry: isOptimisticLockFailure,
        onRetry: (attempt) => {
          attemptsRun = attempt + 1;
        },
      },
    );
    return { todo: toTodoView(next) };
  } catch (error) {
    if (
      attemptsRun >= MAX_OCC_ATTEMPTS &&
      isOptimisticLockFailure(error) &&
      isConflictError(error)
    ) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Failed to change todo status after ${attemptsRun} attempts due to concurrent writers`,
        error,
      );
    }
    throw error;
  }
}

function isOptimisticLockFailure(error: unknown): boolean {
  return (
    isConflictError(error) &&
    error.code === ConflictErrorCode.OptimisticLockFailure
  );
}

function setStatusIfNeeded(
  todo: Todo,
  status: TodoStatusInput,
  now: Date,
): ReturnType<typeof Todo.complete> | ReturnType<typeof Todo.reopen> {
  if (status === "completed") {
    return Todo.isCompleted(todo)
      ? { entity: todo, events: [] }
      : Todo.complete(todo, now);
  }
  return Todo.isActive(todo)
    ? { entity: todo, events: [] }
    : Todo.reopen(todo, now);
}
