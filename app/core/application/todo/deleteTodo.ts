import { z } from "zod";
import { TodoEvents } from "@/core/domain/todo/events";
import {
  NotFoundError,
  ValidationError,
  zodIssuesToFieldErrors,
} from "../errors";
import type { ServiceArgs } from "../types";

export type DeleteTodoInput = {
  id: string;
};

const inputSchema = z.object({
  id: z.string().min(1),
});

export async function deleteTodo({
  container,
  input,
}: ServiceArgs<DeleteTodoInput>): Promise<void> {
  const parsed = parseInput(input);
  const now = container.clock.now();
  const eventId = container.idGenerator.next();

  await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const current = await todoRepository.findById(parsed.id);
      if (!current) {
        throw new NotFoundError(
          "TODO_NOT_FOUND",
          `Todo not found: ${parsed.id}`,
        );
      }
      await todoRepository.delete(current.id, current.version);
      collectEvents([TodoEvents.deleted(eventId, current.id, now)]);
    },
  );
}

function parseInput(input: DeleteTodoInput): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "INVALID_INPUT",
      "Invalid delete-todo input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
  }
  return parsed.data;
}
