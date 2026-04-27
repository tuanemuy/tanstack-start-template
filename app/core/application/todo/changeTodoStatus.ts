import type { Container } from "@/core/application/di/server";
import { BusinessRuleError } from "@/core/domain/error";
import { Todo } from "@/core/domain/todo/entity";
import { TodoErrorCode } from "@/core/domain/todo/errorCode";
import type { TodoEvent } from "@/core/domain/todo/events";
import { TodoId } from "@/core/domain/todo/valueObject";
import {
  ConflictErrorCode,
  isConflictError,
  NotFoundError,
  NotFoundErrorCode,
  ValidationError,
  ValidationErrorCode,
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

function parseId(rawId: string): TodoId {
  try {
    return TodoId.create(rawId);
  } catch (error) {
    if (
      error instanceof BusinessRuleError &&
      error.code === TodoErrorCode.InvalidId
    ) {
      throw new ValidationError(
        ValidationErrorCode.InvalidInput,
        "Invalid id",
        error,
        { id: ["Invalid id format"] },
      );
    }
    throw error;
  }
}

/**
 * Set a todo's status to `active` or `completed`.
 *
 * "Set status to X" is idempotent — re-reading and re-writing on an OCC
 * conflict is safe — so the local retry loop sits inside the usecase
 * rather than surfacing the conflict to the caller. After exhausting the
 * budget, the underlying `ConflictError(OptimisticLockFailure)` propagates
 * verbatim; callers (and observability) get the original error with its
 * cause chain intact rather than a re-wrapped duplicate.
 */
export async function changeTodoStatus({
  container,
  input,
}: ServiceArgs<ChangeTodoStatusInput>): Promise<ChangeTodoStatusOutput> {
  const id = parseId(input.id);

  // Capture "now" once per usecase invocation, before the retry loop, so
  // every attempt — and the eventual successful write — agrees on the same
  // timestamp by construction. The application's notion of "this command's
  // instant" should not jitter between OCC retries.
  const now = container.clock.now();

  const next = await retry(() => attempt(container, id, input.status, now), {
    maxAttempts: MAX_OCC_ATTEMPTS,
    shouldRetry: isOptimisticLockFailure,
  });
  return { todo: toTodoView(next) };
}

async function attempt(
  container: Container,
  id: TodoId,
  status: TodoStatusInput,
  now: Date,
): Promise<Todo> {
  return container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(id);
      if (!current) {
        throw new NotFoundError(
          NotFoundErrorCode.TodoNotFound,
          `Todo not found: ${id}`,
        );
      }

      const transition = setStatusIfNeeded(container, current, status, now);
      if (transition === null) return current;
      await todoRepository.save(transition.entity);
      collectEvents(transition.events);
      return transition.entity;
    },
  );
}

function isOptimisticLockFailure(error: unknown): boolean {
  return (
    isConflictError(error) &&
    error.code === ConflictErrorCode.OptimisticLockFailure
  );
}

/**
 * Returns the next state + events when the status actually needs to change,
 * or `null` for an already-in-target-state no-op. Mints the event id from
 * the container's `IdGenerator` only when a transition is happening — keeps
 * id consumption tight to actual emissions.
 */
function setStatusIfNeeded(
  container: Container,
  todo: Todo,
  status: TodoStatusInput,
  now: Date,
): { entity: Todo; events: readonly TodoEvent[] } | null {
  if (status === "completed") {
    if (Todo.isCompleted(todo)) return null;
    return Todo.complete(todo, container.idGenerator.next(), now);
  }
  if (Todo.isActive(todo)) return null;
  return Todo.reopen(todo, container.idGenerator.next(), now);
}
