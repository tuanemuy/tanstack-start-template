import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
import { NotFoundError, NotFoundErrorCode } from "../error";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./dto";

export type ToggleTodoInput = {
  id: string;
};

export type ToggleTodoOutput = {
  todo: TodoView;
};

export async function toggleTodo({
  container,
  input,
}: ServiceArgs<ToggleTodoInput>): Promise<ToggleTodoOutput> {
  const id = TodoId.create(input.id);

  const updated = await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvent }) => {
      const current = await todoRepository.findById(id);
      if (!current) {
        throw new NotFoundError(
          NotFoundErrorCode.TodoNotFound,
          `Todo not found: ${id}`,
        );
      }
      const { entity: next, events } = Todo.toggle(current);
      await todoRepository.save(next);
      for (const event of events) collectEvent(event);
      return next;
    },
  );

  return { todo: toTodoView(updated) };
}
