import { z } from "zod";
import type { DomainEventBase, EventDecoder } from "@/core/domain/common/event";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";
import { TodoId, TodoTitle } from "./valueObject";

const todoCreatedPayloadSchema = z
  .object({ todoId: z.string(), title: z.string() })
  .strict();
const todoToggledPayloadSchema = z
  .object({ todoId: z.string(), completed: z.boolean() })
  .strict();
const todoRenamedPayloadSchema = z
  .object({ todoId: z.string(), title: z.string() })
  .strict();
const todoDeletedPayloadSchema = z.object({ todoId: z.string() }).strict();

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

export const TodoEvents = {
  created: (
    id: string,
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): TodoCreatedEvent => ({
    id,
    type: "todo.created",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  toggled: (
    id: string,
    todoId: TodoId,
    completed: boolean,
    occurredAt: Date,
  ): TodoToggledEvent => ({
    id,
    type: "todo.toggled",
    payload: { todoId, completed },
    occurredAt,
    aggregateId: todoId,
  }),

  renamed: (
    id: string,
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): TodoRenamedEvent => ({
    id,
    type: "todo.renamed",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  deleted: (
    id: string,
    todoId: TodoId,
    occurredAt: Date,
  ): TodoDeletedEvent => ({
    id,
    type: "todo.deleted",
    payload: { todoId },
    occurredAt,
    aggregateId: todoId,
  }),
};

/**
 * Per-variant decoder map. The mapped type means adding a new {@link TodoEvent}
 * variant without registering its decoder is a compile-time error rather than
 * a runtime surprise. Each decoder re-runs the payload through the domain's
 * value-object factories so consumers see branded types.
 *
 * Tightening a value-object invariant can retroactively reject historical
 * outbox rows — keep changes additive, or introduce a new event type rather
 * than mutating the existing shape.
 */
export type TodoEventDecoders = {
  readonly [K in TodoEvent["type"]]: EventDecoder<
    Extract<TodoEvent, { type: K }>
  >;
};

export const todoEventDecoders: TodoEventDecoders = {
  "todo.created": (_type, payload, meta) => {
    const parsed = todoCreatedPayloadSchema.parse(payload);
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.created",
      payload: {
        todoId: TodoId.create(parsed.todoId),
        title: TodoTitle.create(parsed.title),
      },
    };
  },
  "todo.toggled": (_type, payload, meta) => {
    const parsed = todoToggledPayloadSchema.parse(payload);
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.toggled",
      payload: {
        todoId: TodoId.create(parsed.todoId),
        completed: parsed.completed,
      },
    };
  },
  "todo.renamed": (_type, payload, meta) => {
    const parsed = todoRenamedPayloadSchema.parse(payload);
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.renamed",
      payload: {
        todoId: TodoId.create(parsed.todoId),
        title: TodoTitle.create(parsed.title),
      },
    };
  },
  "todo.deleted": (_type, payload, meta) => {
    const parsed = todoDeletedPayloadSchema.parse(payload);
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.deleted",
      payload: { todoId: TodoId.create(parsed.todoId) },
    };
  },
};

function isTodoEventType(type: string): type is TodoEvent["type"] {
  return type in todoEventDecoders;
}

export const decodeTodoEvent: EventDecoder<TodoEvent> = (
  type,
  payload,
  meta,
) => {
  if (!isTodoEventType(type)) {
    throw new BusinessRuleError(
      TodoErrorCode.UnknownEventType,
      `Unknown todo event type: ${type}`,
    );
  }
  return todoEventDecoders[type](type, payload, meta);
};
