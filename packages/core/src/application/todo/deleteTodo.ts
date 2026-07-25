import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { NotFoundError } from "../errors";
import type { ServiceArgs } from "../types";

export type DeleteTodoInput = {
  id: string;
};

export async function deleteTodo({
  container,
  input,
}: ServiceArgs<DeleteTodoInput>): Promise<void> {
  const now = container.clock.now();
  const id = TodoId.create(input.id);

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const found = await todoRepository.findById(id);
      if (!found) {
        throw new NotFoundError(
          "TODO_NOT_FOUND",
          `Todo not found: ${input.id}`,
        );
      }
      await todoRepository.delete(found.entity.id, found.expectedVersion);
      collectEvents([TodoEvents.deleted(found.entity.id, now)]);
    },
  );
}
