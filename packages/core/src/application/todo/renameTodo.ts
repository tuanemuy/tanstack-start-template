import { Todo } from "@repo/core/domain/todo/entity";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { NotFoundError } from "../errors";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type RenameTodoInput = {
  id: string;
  title: string;
};

export type RenameTodoOutput = {
  todo: TodoView;
};

export async function renameTodo({
  container,
  input,
}: ServiceArgs<RenameTodoInput>): Promise<RenameTodoOutput> {
  const now = container.clock.now();
  const id = TodoId.create(input.id);

  const next = await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const found = await todoRepository.findById(id);
      if (!found) {
        throw new NotFoundError(
          "TODO_NOT_FOUND",
          `Todo not found: ${input.id}`,
        );
      }

      const { entity: renamed, eventDrafts } = Todo.rename(
        found.entity,
        input.title,
        now,
      );
      if (eventDrafts.length === 0) return found.entity;
      await todoRepository.save(renamed, found.expectedVersion);
      collectEvents(eventDrafts);
      return renamed;
    },
  );

  return { todo: toTodoView(next) };
}
