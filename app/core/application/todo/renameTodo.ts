import { Todo } from "@/core/domain/todo/entity";
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

  const next = await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(input.id);
      if (!current) {
        throw new NotFoundError(
          "TODO_NOT_FOUND",
          `Todo not found: ${input.id}`,
        );
      }

      const { entity, eventDrafts } = Todo.rename(current, input.title, now);
      if (eventDrafts.length === 0) return current;
      await todoRepository.save(entity);
      collectEvents(eventDrafts);
      return entity;
    },
  );

  return { todo: toTodoView(next) };
}
