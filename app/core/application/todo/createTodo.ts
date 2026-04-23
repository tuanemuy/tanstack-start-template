import { Todo } from "@/core/domain/todo/entity";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./dto";

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
  const { entity: todo, events } = Todo.create({ title: input.title });

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvent }) => {
      await todoRepository.save(todo);
      for (const event of events) collectEvent(event);
    },
  );

  return { todo: toTodoView(todo) };
}
