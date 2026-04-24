import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
import { NotFoundError, NotFoundErrorCode } from "../errors";
import type { ServiceArgs } from "../types";

export type DeleteTodoInput = {
  id: string;
};

export async function deleteTodo({
  container,
  input,
}: ServiceArgs<DeleteTodoInput>): Promise<void> {
  const id = TodoId.create(input.id);
  // Resolve "now" once per call so the deletion event's `occurredAt` is
  // captured at the usecase entry rather than inside the domain — keeps the
  // domain pure, no `new Date()` at the bottom of the call stack.
  const now = container.clock.now();

  await container.unitOfWorkProvider.runReadWrite(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(id);
      if (!current) {
        throw new NotFoundError(
          NotFoundErrorCode.TodoNotFound,
          `Todo not found: ${id}`,
        );
      }
      // `Todo.delete` returns `WithEvents<null, …>` — `entity: null` marks
      // the aggregate as gone, per the `WithEvents` convention for deletion.
      const { events } = Todo.delete(current, now);
      // Pass the version read above so the adapter's DELETE is guarded by
      // an optimistic-lock predicate (`WHERE version = ?`). A concurrent
      // writer that already advanced the version surfaces as
      // `ConflictError(OptimisticLockFailure)`.
      await todoRepository.delete(id, current.version);
      // `Todo.delete` always emits a single `todo.deleted` event, so the
      // `events.length === 0` guard used on idempotent mutations doesn't
      // apply here — a successful delete must always publish.
      collectEvents(events);
    },
  );
}
