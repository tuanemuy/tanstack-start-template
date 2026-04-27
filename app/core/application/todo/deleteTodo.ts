import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "@/core/domain/todo/errorCode";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId } from "@/core/domain/todo/valueObject";
import {
  NotFoundError,
  NotFoundErrorCode,
  ValidationError,
  ValidationErrorCode,
} from "../errors";
import type { ServiceArgs } from "../types";

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

export type DeleteTodoInput = {
  id: string;
};

export async function deleteTodo({
  container,
  input,
}: ServiceArgs<DeleteTodoInput>): Promise<void> {
  const id = parseId(input.id);
  // Resolve "now" once per call so the deletion event's `occurredAt` is
  // captured at the usecase entry rather than inside the domain — keeps the
  // domain pure, no `new Date()` at the bottom of the call stack.
  const now = container.clock.now();
  const eventId = container.idGenerator.next();

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(id);
      if (!current) {
        throw new NotFoundError(
          NotFoundErrorCode.TodoNotFound,
          `Todo not found: ${id}`,
        );
      }
      // Pass the version read above so the adapter's DELETE is guarded by
      // an optimistic-lock predicate (`WHERE version = ?`). A concurrent
      // writer that already advanced the version surfaces as
      // `ConflictError(OptimisticLockFailure)`.
      await todoRepository.delete(id, current.version);
      // Deletion produces no successor entity, so the usecase emits the
      // `todo.deleted` event directly rather than going through a domain
      // method that would just return `WithEvents<null, …>` with no logic
      // of its own. Keeping this in the usecase layer (next to the
      // `todoRepository.delete` call) makes the "what was published when"
      // story trivially traceable.
      collectEvents([TodoEvents.deleted(eventId, id, now)]);
    },
  );
}
