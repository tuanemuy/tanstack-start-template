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
    async ({ todoRepository, collectEvent }) => {
      const current = await todoRepository.findById(id);
      if (!current) {
        throw new NotFoundError(
          NotFoundErrorCode.TodoNotFound,
          `Todo not found: ${id}`,
        );
      }
      // `Todo.delete` yields the `todo.deleted` event; the aggregate itself
      // is gone after this call so `entity` is intentionally `null`.
      const { events } = Todo.delete(current);
      await todoRepository.delete(id);
      for (const event of events) collectEvent(event);
    },
  );
}
