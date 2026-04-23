import { v7 as uuidv7 } from "uuid";
import type {
  DomainEventBase,
  EventDecodeMeta,
  EventDecoder,
} from "@/core/domain/common/event";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";
import { TodoId, TodoTitle } from "./valueObject";

/**
 * The on-the-wire schema version this module knows how to encode/decode.
 *
 * Bump when the shape of a payload changes in a way consumers must adapt to,
 * and add a case for the previous version in {@link decodeTodoEvent} so that
 * already-persisted outbox rows keep flowing.
 */
export const TODO_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Payload serialization note (applies to every event type in this module):
 *
 * The `payload` on each `Todo*Event` is a **wire type**, not a domain type.
 * When the outbox persists or relays the event, branded value-object types
 * (`TodoId`, `TodoTitle`) flatten to plain strings — the brand exists only
 * in the in-process TypeScript type system and cannot survive JSON
 * serialization. Use {@link decodeTodoEvent} to re-validate the payload
 * through the corresponding value-object factories on read.
 */

export type TodoCreatedEvent = DomainEventBase<
  "todo.created",
  { todoId: TodoId; title: TodoTitle }
>;

export type TodoToggledEvent = DomainEventBase<
  "todo.toggled",
  { todoId: TodoId; completed: boolean }
>;

export type TodoRenamedEvent = DomainEventBase<
  "todo.renamed",
  { todoId: TodoId; title: TodoTitle }
>;

export type TodoDeletedEvent = DomainEventBase<
  "todo.deleted",
  { todoId: TodoId }
>;

export type TodoEvent =
  | TodoCreatedEvent
  | TodoToggledEvent
  | TodoRenamedEvent
  | TodoDeletedEvent;

export const TodoEvents = {
  created: (todoId: TodoId, title: TodoTitle): TodoCreatedEvent => ({
    id: uuidv7(),
    type: "todo.created",
    payload: { todoId, title },
    occurredAt: new Date(),
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),

  toggled: (todoId: TodoId, completed: boolean): TodoToggledEvent => ({
    id: uuidv7(),
    type: "todo.toggled",
    payload: { todoId, completed },
    occurredAt: new Date(),
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),

  renamed: (todoId: TodoId, title: TodoTitle): TodoRenamedEvent => ({
    id: uuidv7(),
    type: "todo.renamed",
    payload: { todoId, title },
    occurredAt: new Date(),
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),

  deleted: (todoId: TodoId): TodoDeletedEvent => ({
    id: uuidv7(),
    type: "todo.deleted",
    payload: { todoId },
    occurredAt: new Date(),
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),
};

/**
 * Reconstruct a typed `TodoEvent` from its wire representation.
 *
 * Re-runs the payload through the domain's value-object factories so that
 * consumers always see branded types (`TodoId`, `TodoTitle`) rather than
 * free-form strings. Unknown event types or unsupported schema versions
 * are rejected with `BusinessRuleError` so that downstream handlers never
 * silently consume malformed messages.
 */
export const decodeTodoEvent: EventDecoder<TodoEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: EventDecodeMeta,
): TodoEvent => {
  if (meta.schemaVersion !== TODO_EVENT_SCHEMA_VERSION) {
    throw new BusinessRuleError(
      TodoErrorCode.UnsupportedEventSchema,
      `Unsupported todo event schema version: ${meta.schemaVersion}`,
    );
  }
  const base = {
    id: meta.id,
    occurredAt: meta.occurredAt,
    schemaVersion: meta.schemaVersion,
    ...(meta.aggregateId !== undefined
      ? { aggregateId: meta.aggregateId }
      : {}),
  };
  const todoId = TodoId.create(String(payload.todoId));
  switch (type) {
    case "todo.created":
      return {
        ...base,
        type: "todo.created",
        payload: { todoId, title: TodoTitle.create(String(payload.title)) },
      };
    case "todo.toggled":
      return {
        ...base,
        type: "todo.toggled",
        payload: { todoId, completed: Boolean(payload.completed) },
      };
    case "todo.renamed":
      return {
        ...base,
        type: "todo.renamed",
        payload: { todoId, title: TodoTitle.create(String(payload.title)) },
      };
    case "todo.deleted":
      return { ...base, type: "todo.deleted", payload: { todoId } };
    default:
      throw new BusinessRuleError(
        TodoErrorCode.UnknownEventType,
        `Unknown todo event type: ${type}`,
      );
  }
};
