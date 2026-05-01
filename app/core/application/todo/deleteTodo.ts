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
  const eventId = container.idGenerator.next();

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(input.id);
      if (!current) {
        throw new NotFoundError(
          "TODO_NOT_FOUND",
          `Todo not found: ${input.id}`,
        );
      }
      await todoRepository.delete(current.id, current.version);
      collectEvents([TodoEvents.deleted(eventId, current.id, now)]);
    },
  );
}
