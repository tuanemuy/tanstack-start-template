import type {
  DomainEventBase,
  EventDraft,
} from "@repo/core/domain/common/event";
import type { TodoId, TodoTitle } from "./valueObject";

export type TodoCreatedEvent = DomainEventBase<
  "todo.created",
  Readonly<{ todoId: TodoId; title: TodoTitle }>
>;

export type TodoToggledEvent = DomainEventBase<
  "todo.toggled",
  Readonly<{ todoId: TodoId; completed: boolean }>
>;

export type TodoRenamedEvent = DomainEventBase<
  "todo.renamed",
  Readonly<{ todoId: TodoId; title: TodoTitle }>
>;

export type TodoDeletedEvent = DomainEventBase<
  "todo.deleted",
  Readonly<{ todoId: TodoId }>
>;

export type TodoEvent =
  | TodoCreatedEvent
  | TodoToggledEvent
  | TodoRenamedEvent
  | TodoDeletedEvent;

// Domain factories return identity-less drafts; `EventId` is attached by the
// application layer so the domain remains free of `IdGenerator` concerns.
export const TodoEvents = {
  created: (
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): EventDraft<TodoCreatedEvent> => ({
    type: "todo.created",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  toggled: (
    todoId: TodoId,
    completed: boolean,
    occurredAt: Date,
  ): EventDraft<TodoToggledEvent> => ({
    type: "todo.toggled",
    payload: { todoId, completed },
    occurredAt,
    aggregateId: todoId,
  }),

  renamed: (
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): EventDraft<TodoRenamedEvent> => ({
    type: "todo.renamed",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  deleted: (
    todoId: TodoId,
    occurredAt: Date,
  ): EventDraft<TodoDeletedEvent> => ({
    type: "todo.deleted",
    payload: { todoId },
    occurredAt,
    aggregateId: todoId,
  }),
};
