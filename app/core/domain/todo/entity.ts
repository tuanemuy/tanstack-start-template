import type { EventId, WithEvents } from "@/core/domain/common/event";
import { type TodoEvent, TodoEvents } from "./events";
import { TodoId, TodoTitle } from "./valueObject";

type TodoBase = Readonly<{
  id: TodoId;
  title: TodoTitle;
  // Monotonic revision counter for optimistic locking.
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ActiveTodo = TodoBase & Readonly<{ status: "active" }>;
export type CompletedTodo = TodoBase & Readonly<{ status: "completed" }>;

export type Todo = ActiveTodo | CompletedTodo;

function complete(
  todo: ActiveTodo,
  eventId: EventId,
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
  eventId: EventId,
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
  todo: Todo,
  newTitle: string,
  eventId: EventId,
  now: Date,
): WithEvents<Todo, TodoEvent> {
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

  create: (
    params: { id: string; eventId: EventId; title: string },
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
