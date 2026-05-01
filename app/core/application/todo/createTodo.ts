import { z } from "zod";
import { Todo } from "@/core/domain/todo/entity";
import { ValidationError, zodIssuesToFieldErrors } from "../errors";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type CreateTodoInput = {
  title: string;
};

export type CreateTodoOutput = {
  todo: TodoView;
};

const TODO_TITLE_MAX_LENGTH = 140;
const inputSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export async function createTodo({
  container,
  input,
}: ServiceArgs<CreateTodoInput>): Promise<CreateTodoOutput> {
  const parsed = parseInput(input);
  const now = container.clock.now();
  const id = container.idGenerator.next();
  const eventId = container.idGenerator.next();
  const { entity: todo, events } = Todo.create(
    { id, eventId, title: parsed.title },
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

function parseInput(input: CreateTodoInput): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "INVALID_INPUT",
      "Invalid create-todo input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
  }
  return parsed.data;
}
