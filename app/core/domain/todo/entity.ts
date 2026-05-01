import type { WithEvents } from "@/core/domain/common/event";
import { type TodoEvent, TodoEvents } from "./events";
import { TodoId, TodoTitle } from "./valueObject";

type TodoBase = Readonly<{
  id: TodoId;
  title: TodoTitle;
  /** Monotonic revision counter for optimistic locking. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ActiveTodo = TodoBase & Readonly<{ status: "active" }>;
export type CompletedTodo = TodoBase & Readonly<{ status: "completed" }>;

/**
 * Todo aggregate. Discriminated on `status`, so state-specific operations
 * (`complete`, `reopen`) require the correct variant at compile time.
 */
export type Todo = ActiveTodo | CompletedTodo;

function complete(
  todo: ActiveTodo,
  eventId: string,
  now: Date,
): WithEvents<CompletedTodo, TodoEvent> {
  const next: CompletedTodo = {
    ...todo,
    status: "completed",
    version: todo.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    events: [TodoEvents.toggled(eventId, next.id, true, now)],
  };
}

function reopen(
  todo: CompletedTodo,
  eventId: string,
  now: Date,
): WithEvents<ActiveTodo, TodoEvent> {
  const next: ActiveTodo = {
    ...todo,
    status: "active",
    version: todo.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    events: [TodoEvents.toggled(eventId, next.id, false, now)],
  };
}

function rename(
  todo: ActiveTodo,
  newTitle: string,
  eventId: string,
  now: Date,
): WithEvents<ActiveTodo, TodoEvent>;
function rename(
  todo: CompletedTodo,
  newTitle: string,
  eventId: string,
  now: Date,
): WithEvents<CompletedTodo, TodoEvent>;
function rename(
  todo: Todo,
  newTitle: string,
  eventId: string,
  now: Date,
): WithEvents<Todo, TodoEvent>;
function rename(
  todo: Todo,
  newTitle: string,
  eventId: string,
  now: Date,
): WithEvents<Todo, TodoEvent> {
  // Validate before the idempotency short-circuit: an invalid input is not
  // "the same as current", it is malformed. Comparing raw input against the
  // already-normalized title would also let unnormalized inputs slip past.
  const title = TodoTitle.create(newTitle);
  if (title === todo.title) {
    return { entity: todo, events: [] };
  }
  const next: Todo = {
    ...todo,
    title,
    version: todo.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    events: [TodoEvents.renamed(eventId, next.id, title, now)],
  };
}

export const Todo = {
  isActive: (todo: Todo): todo is ActiveTodo => todo.status === "active",
  isCompleted: (todo: Todo): todo is CompletedTodo =>
    todo.status === "completed",

  /**
   * Create a new todo aggregate. Single branding point for `TodoId` — the
   * application layer never constructs value objects from external input.
   */
  create: (
    params: { id: string; eventId: string; title: string },
    now: Date,
  ): WithEvents<ActiveTodo, TodoEvent> => {
    const id = TodoId.create(params.id);
    const todo: ActiveTodo = {
      status: "active",
      id,
      title: TodoTitle.create(params.title),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return {
      entity: todo,
      events: [TodoEvents.created(params.eventId, todo.id, todo.title, now)],
    };
  },

  rename,

  complete,

  reopen,
};
