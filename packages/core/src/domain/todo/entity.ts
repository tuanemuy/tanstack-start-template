import type { WithEventDrafts } from "@repo/core/domain/common/event";
import { Version } from "@repo/core/domain/common/version";
import { RehydrationError } from "@repo/core/domain/error";
import { type TodoEvent, TodoEvents } from "./events";
import { TodoId, TodoStatus, TodoTitle } from "./valueObject";

type TodoBase = Readonly<{
  id: TodoId;
  title: TodoTitle;
  version: Version;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ActiveTodo = TodoBase & Readonly<{ status: "active" }>;
export type CompletedTodo = TodoBase & Readonly<{ status: "completed" }>;

export type Todo = ActiveTodo | CompletedTodo;

function complete(
  todo: ActiveTodo,
  now: Date,
): WithEventDrafts<CompletedTodo, TodoEvent> {
  const next: CompletedTodo = {
    ...todo,
    status: "completed",
    version: Version.next(todo.version),
    updatedAt: now,
  };
  return {
    entity: next,
    eventDrafts: [TodoEvents.toggled(next.id, true, now)],
  };
}

function reopen(
  todo: CompletedTodo,
  now: Date,
): WithEventDrafts<ActiveTodo, TodoEvent> {
  const next: ActiveTodo = {
    ...todo,
    status: "active",
    version: Version.next(todo.version),
    updatedAt: now,
  };
  return {
    entity: next,
    eventDrafts: [TodoEvents.toggled(next.id, false, now)],
  };
}

function rename(
  todo: Todo,
  newTitle: string,
  now: Date,
): WithEventDrafts<Todo, TodoEvent> {
  const title = TodoTitle.create(newTitle);
  if (title === todo.title) {
    return { entity: todo, eventDrafts: [] };
  }
  const next: Todo = {
    ...todo,
    title,
    version: Version.next(todo.version),
    updatedAt: now,
  };
  return {
    entity: next,
    eventDrafts: [TodoEvents.renamed(next.id, title, now)],
  };
}

// Loose-typed because adapters feed untrusted persistence rows; each field
// is re-validated through its value object inside `reconstruct`.
type ReconstructInput = Readonly<{
  id: string;
  title: string;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export const Todo = {
  isActive: (todo: Todo): todo is ActiveTodo => todo.status === "active",
  isCompleted: (todo: Todo): todo is CompletedTodo =>
    todo.status === "completed",

  create: (
    params: { id: string; title: string },
    now: Date,
  ): WithEventDrafts<ActiveTodo, TodoEvent> => {
    const todo: ActiveTodo = {
      status: "active",
      id: TodoId.create(params.id),
      title: TodoTitle.create(params.title),
      version: Version.initial(),
      createdAt: now,
      updatedAt: now,
    };
    return {
      entity: todo,
      eventDrafts: [TodoEvents.created(todo.id, todo.title, now)],
    };
  },

  // Value objects throw `BusinessRuleError` from their `create` paths to
  // signal "fresh input is invalid" at the usecase boundary. The same
  // failure during rehydration is operationally a different beast — it
  // means stored data has drifted from the schema — so wrap any error
  // here into `RehydrationError`. Adapters translate it to
  // `SystemError(DataIntegrityError)`; usecases never see either.
  reconstruct: (input: ReconstructInput): Todo => {
    try {
      const base = {
        id: TodoId.create(input.id),
        title: TodoTitle.create(input.title),
        version: Version.create(input.version),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      const status = TodoStatus.create(input.status);
      return status === "completed"
        ? ({ ...base, status } satisfies CompletedTodo)
        : ({ ...base, status } satisfies ActiveTodo);
    } catch (error) {
      throw new RehydrationError(
        `Failed to rehydrate Todo (id=${input.id})`,
        error,
      );
    }
  },

  rename,

  complete,

  reopen,
};
