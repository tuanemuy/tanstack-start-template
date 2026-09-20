import { Todo } from "@repo/core/domain/todo/entity";
import { ConflictError } from "../errors";
import type { GeneratedId } from "../ports/idGenerator";
import type { ServiceArgs } from "../types";
import { type TodoView, toTodoView } from "./view";

export type CreateTodoInput = {
  id: GeneratedId;
  title: string;
};

export type CreateTodoOutput = {
  todo: TodoView;
};

/**
 * Creates a todo under a caller-chosen id. Idempotent on that id.
 *
 * A create whose response is lost looks like a failure to the caller, and a
 * server-assigned id would turn the retry into a second todo. The caller mints
 * the id instead and resends the same one: a replay finds the todo already
 * there, writes nothing, emits no second `todo.created`, and returns it.
 *
 * - **Replay** is "same id, same title". The same id with a different title is
 *   a caller reusing an id for another todo; answering it with the existing
 *   todo would silently drop the new one, so it is a
 *   `ConflictError("TODO_ID_CONFLICT")`. The check is against the todo's
 *   current title, so a replay that arrives after a rename also conflicts.
 * - **Concurrent replays** can both miss the lookup; the loser's insert then
 *   fails on the primary key as `ConflictError("UNIQUE_VIOLATION")`. It is not
 *   caught here — resending the same id again takes the replay path.
 * - **Id format.** The id is a `GeneratedId`, which only `IdGenerator.next` /
 *   `parse` produce — the check adapters apply on rehydration — so a caller
 *   cannot store a row that can never be read back. A transport receiving the
 *   id as a string parses it at its boundary with the generator the container
 *   wires.
 *
 * Once todos have an owner, a replay must also match on it: an existing todo
 * owned by someone else is a conflict whatever its title.
 */
export async function createTodo({
  container,
  input,
}: ServiceArgs<CreateTodoInput>): Promise<CreateTodoOutput> {
  const now = container.clock.now();
  const { entity: todo, eventDrafts } = Todo.create(
    { id: input.id, title: input.title },
    now,
  );

  const created = await container.unitOfWorkProvider.run(
    async ({ todoRepository, collectEvents }) => {
      const found = await todoRepository.findById(todo.id);
      if (found) {
        if (found.entity.title !== todo.title) {
          throw new ConflictError(
            "TODO_ID_CONFLICT",
            `Todo id already in use: ${todo.id}`,
          );
        }
        return found.entity;
      }
      await todoRepository.insert(todo);
      collectEvents(eventDrafts);
      return todo;
    },
  );

  return { todo: toTodoView(created) };
}
