import { v7 as uuidv7 } from "uuid";
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

/**
 * Factories for fresh in-process `TodoEvent`s.
 *
 * Each factory takes `occurredAt: Date` so the domain stays clock-free.
 * Callers — typically the application layer — resolve `now` once at the
 * usecase entry and thread that value into both the entity and its emitted
 * events, so the entity's `updatedAt` and the event's `occurredAt` agree by
 * construction.
 */
export const TodoEvents = {
  created: (
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): TodoCreatedEvent => ({
    id: uuidv7(),
    type: "todo.created",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  toggled: (
    todoId: TodoId,
    completed: boolean,
    occurredAt: Date,
  ): TodoToggledEvent => ({
    id: uuidv7(),
    type: "todo.toggled",
    payload: { todoId, completed },
    occurredAt,
    aggregateId: todoId,
  }),

  renamed: (
    todoId: TodoId,
    title: TodoTitle,
    occurredAt: Date,
  ): TodoRenamedEvent => ({
    id: uuidv7(),
    type: "todo.renamed",
    payload: { todoId, title },
    occurredAt,
    aggregateId: todoId,
  }),

  deleted: (todoId: TodoId, occurredAt: Date): TodoDeletedEvent => ({
    id: uuidv7(),
    type: "todo.deleted",
    payload: { todoId },
    occurredAt,
    aggregateId: todoId,
  }),
};

/**
 * Reconstruct a typed `TodoEvent` from its wire representation.
 *
 * Re-runs the payload through the domain's value-object factories so consumers
 * always see branded types (`TodoId`, `TodoTitle`). Throws `BusinessRuleError`
 * on a malformed row — the relay worker catches per-row so one bad row does
 * not abort the whole batch.
 */
export const decodeTodoEvent: EventDecoder<TodoEvent> = (
  type,
  payload,
  meta,
) => {
  const base = {
    id: meta.id,
    occurredAt: meta.occurredAt,
    aggregateId: meta.aggregateId,
  };
  switch (type) {
    case "todo.created": {
      const parsed = todoCreatedPayloadSchema.parse(payload);
      return {
        ...base,
        type: "todo.created",
        payload: {
          todoId: TodoId.create(parsed.todoId),
          title: TodoTitle.create(parsed.title),
        },
      };
    }
    case "todo.toggled": {
      const parsed = todoToggledPayloadSchema.parse(payload);
      return {
        ...base,
        type: "todo.toggled",
        payload: {
          todoId: TodoId.create(parsed.todoId),
          completed: parsed.completed,
        },
      };
    }
    case "todo.renamed": {
      const parsed = todoRenamedPayloadSchema.parse(payload);
      return {
        ...base,
        type: "todo.renamed",
        payload: {
          todoId: TodoId.create(parsed.todoId),
          title: TodoTitle.create(parsed.title),
        },
      };
    }
    case "todo.deleted": {
      const parsed = todoDeletedPayloadSchema.parse(payload);
      return {
        ...base,
        type: "todo.deleted",
        payload: { todoId: TodoId.create(parsed.todoId) },
      };
    }
    default:
      throw new BusinessRuleError(
        TodoErrorCode.UnknownEventType,
        `Unknown todo event type: ${type}`,
      );
  }
};
