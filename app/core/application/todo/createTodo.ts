import { Todo } from "@/core/domain/todo/entity";
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
  // Resolve "now" once at the entry point and pass the resulting `Date` into
  // every domain operation that needs a timestamp. The domain layer never
  // touches the Clock port — it stays pure, taking a `Date` value as input.
  const now = container.clock.now();
  const { entity: todo, events } = Todo.create({ title: input.title }, now);

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      await todoRepository.save(todo);
      collectEvents(events);
    },
  );

  return { todo: toTodoView(todo) };
}
