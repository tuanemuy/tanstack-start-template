import { Todo } from "@repo/core/domain/todo/entity";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type CreateTodoInput = {
  title: string;
};

export type CreateTodoOutput = {
  todo: TodoView;
};

export async function createTodo({
  container,
  input,
}: ServiceArgs<CreateTodoInput>): Promise<CreateTodoOutput> {
  const now = container.clock.now();
  const id = container.idGenerator.next();
  const { entity: todo, eventDrafts } = Todo.create(
    { id, title: input.title },
    now,
  );

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      await todoRepository.insert(todo);
      collectEvents(eventDrafts);
    },
  );

  return { todo: toTodoView(todo) };
}
