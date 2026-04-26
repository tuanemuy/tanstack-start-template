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
 * Each factory takes `id` and `occurredAt` as required arguments so the
 * domain stays free of ambient I/O — no `new Date()`, no `uuidv7()` at the
 * bottom of the call stack. Callers (typically the application layer)
 * resolve `now` once via `container.clock.now()` and mint the event id once
 * via `container.idGenerator.next()`, then thread both values through every
 * factory, so the entity's `updatedAt` and the event's `occurredAt` agree by
 * construction and ids stay deterministic in tests.
 */
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
 * Reconstruct a typed `TodoEvent` from its wire representation.
 *
 * Re-runs the payload through the domain's value-object factories so consumers
 * always see branded types (`TodoId`, `TodoTitle`). Throws `BusinessRuleError`
 * on a malformed row — the relay worker catches per-row so one bad row does
 * not abort the whole batch.
 *
 * ## Coupling note
 *
 * The decoder reapplies value-object invariants (`TodoTitle.create` etc.) to
 * stored payloads. If those invariants are *tightened* later (e.g. shorter max
 * length, stricter regex), historical outbox rows that were valid at write
 * time may start failing decode. Either keep invariant changes additive
 * (looser) or introduce a new event type rather than mutating the existing
 * shape — this is the same rule called out in the README for wire-format
 * compatibility.
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
