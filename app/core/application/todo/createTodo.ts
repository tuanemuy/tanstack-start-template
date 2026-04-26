import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
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
  // Mint both ids up front via the IdGenerator port. Doing this here (rather
  // than in the domain) is what keeps the domain factory deterministic and
  // free of ambient I/O — the domain only sees fully-formed strings.
  const id = TodoId.create(container.idGenerator.next());
  const eventId = container.idGenerator.next();
  const { entity: todo, events } = Todo.create(
    { id, eventId, title: input.title },
    now,
  );

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      await todoRepository.save(todo);
      collectEvents(events);
    },
  );

  return { todo: toTodoView(todo) };
}
