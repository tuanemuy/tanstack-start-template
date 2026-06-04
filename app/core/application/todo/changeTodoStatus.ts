import type { EventDraft } from "@/core/domain/common/event";
import { Todo } from "@/core/domain/todo/entity";
import type { TodoEvent } from "@/core/domain/todo/events";
import { TodoId } from "@/core/domain/todo/valueObject";
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

      const transition = setStatusIfNeeded(found.entity, input.status, now);
      if (transition === null) return found.entity;
      await todoRepository.save(transition.entity, found.expectedVersion);
      collectEvents(transition.eventDrafts);
      return transition.entity;
    },
  );

  return { todo: toTodoView(next) };
}

function setStatusIfNeeded(
  todo: Todo,
  status: TodoStatusInput,
  now: Date,
): {
  entity: Todo;
  eventDrafts: readonly EventDraft<TodoEvent>[];
} | null {
  if (status === "completed") {
    if (Todo.isCompleted(todo)) return null;
    return Todo.complete(todo, now);
  }
  if (Todo.isActive(todo)) return null;
  return Todo.reopen(todo, now);
}
