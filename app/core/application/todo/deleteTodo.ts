import { TodoEvents } from "@/core/domain/todo/events";
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

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const found = await todoRepository.findById(input.id);
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
