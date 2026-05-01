import type { Container } from "@/core/application/di/server";
import { Todo } from "@/core/domain/todo/entity";
import type { TodoEvent } from "@/core/domain/todo/events";
import { NotFoundError } from "../errors";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type TodoStatusInput = "active" | "completed";

export type ChangeTodoStatusInput = {
  id: string;
  status: TodoStatusInput;
};

export type ChangeTodoStatusOutput = {
  todo: TodoView;
};

export async function changeTodoStatus({
  container,
  input,
}: ServiceArgs<ChangeTodoStatusInput>): Promise<ChangeTodoStatusOutput> {
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

      const transition = setStatusIfNeeded(
        container,
        current,
        input.status,
        now,
      );
      if (transition === null) return current;
      await todoRepository.save(transition.entity);
      collectEvents(transition.events);
      return transition.entity;
    },
  );

  return { todo: toTodoView(next) };
}

function setStatusIfNeeded(
  container: Container,
  todo: Todo,
  status: TodoStatusInput,
  now: Date,
): { entity: Todo; events: readonly TodoEvent[] } | null {
  if (status === "completed") {
    if (Todo.isCompleted(todo)) return null;
    return Todo.complete(todo, container.idGenerator.next(), now);
  }
  if (Todo.isActive(todo)) return null;
  return Todo.reopen(todo, container.idGenerator.next(), now);
}
