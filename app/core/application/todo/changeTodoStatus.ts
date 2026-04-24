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
import { type TodoView, toTodoView } from "./dto";

export type TodoStatusInput = "active" | "completed";

export type ChangeTodoStatusInput = {
  id: string;
  status: TodoStatusInput;
};

export type ChangeTodoStatusOutput = {
  todo: TodoView;
};

const MAX_OCC_ATTEMPTS = 2;

export async function changeTodoStatus({
  container,
  input,
}: ServiceArgs<ChangeTodoStatusInput>): Promise<ChangeTodoStatusOutput> {
  const id = TodoId.create(input.id);

  // "Set status to X" is idempotent — re-reading and re-writing on OCC
  // conflict is safe — so we drive the local retry loop here rather than
  // surfacing the conflict to the caller. `retry` re-throws the last error
  // verbatim, so we wrap it in `try / catch` and translate "exhausted
  // retries on a retryable OCC conflict" into a typed `ConflictError` for
  // the presentation layer.
  //
  // `onRetry` is wired in as an observability hook so we can include the
  // attempt count in the eventual `ConflictError` message without leaking
  // bookkeeping into `retry`'s return type.
  let attemptsRun = 1;
  try {
    const next = await retry(
      () =>
        container.unitOfWorkProvider.runReadWrite(
          async ({ todoRepository, collectEvents }) => {
            const current = await todoRepository.findById(id);
            if (!current) {
              throw new NotFoundError(
                NotFoundErrorCode.TodoNotFound,
                `Todo not found: ${id}`,
              );
            }

            // Resolve "now" inside the retry body, not outside, so each
            // attempt gets a fresh timestamp. If we hoisted this above the
            // loop, every retry would re-stamp `updatedAt` with the time of
            // the first attempt, which would lie about when the eventual
            // successful mutation actually happened.
            const now = container.clock.now();
            const { entity: next, events } = setStatusIfNeeded(
              current,
              input.status,
              now,
            );
            if (events.length === 0) {
              return current;
            }
            await todoRepository.save(next);
            collectEvents(events);
            return next;
          },
        ),
      {
        maxAttempts: MAX_OCC_ATTEMPTS,
        shouldRetry: isOptimisticLockFailure,
        onRetry: (attempt) => {
          // `attempt` is the 1-indexed number that just failed; the next
          // attempt is `attempt + 1`. Tracking the highest attempt number
          // we have observed gives us the right total whether the loop
          // succeeds on a later attempt or finally exhausts its budget.
          attemptsRun = attempt + 1;
        },
      },
    );
    return { todo: toTodoView(next) };
  } catch (error) {
    // Two shapes worth distinguishing on the catch side:
    //
    // - The error is a retryable OCC conflict and we burned through every
    //   attempt — surface as `ConflictError(OptimisticLockFailure)` with a
    //   message that names the budget so operators can tell it apart from
    //   a first-attempt conflict.
    // - Anything else (e.g. `NotFoundError`) — re-throw verbatim so its
    //   identity (typed subclass, `code`, original `cause`) is preserved
    //   end-to-end.
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
