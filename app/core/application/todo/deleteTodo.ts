import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
import { NotFoundError, NotFoundErrorCode } from "../error";
import type { ServiceArgs } from "../types";

export type DeleteTodoInput = {
  id: string;
};

export async function deleteTodo({
  container,
  input,
}: ServiceArgs<DeleteTodoInput>): Promise<void> {
  const id = TodoId.create(input.id);

  await container.unitOfWorkProvider.run(
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
      const { events } = Todo.delete(current);
      // Pass the version read above so the adapter's DELETE is guarded by
      // an optimistic-lock predicate (`WHERE version = ?`). A concurrent
      // writer that already advanced the version surfaces as
      // `ConflictError(OptimisticLockFailure)`.
      await todoRepository.delete(id, current.version);
      collectEvents(events);
    },
  );
}
