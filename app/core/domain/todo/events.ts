import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  DomainEventBase,
  EventDecodeMeta,
  EventDecodeResult,
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

/**
 * Wire payloads (JSON-safe, after serialization).
 *
 * Branded value-object types (`TodoId`, `TodoTitle`) collapse to raw strings
 * once they cross the outbox, so the wire shape we read back from storage is
 * typed as `string`. {@link decodeTodoEvent} is the only supported path from
 * wire -> domain, and re-runs each string through its value-object factory.
 */
export type TodoCreatedEventPayload = Readonly<{
  todoId: string;
  title: string;
}>;

export type TodoToggledEventPayload = Readonly<{
  todoId: string;
  completed: boolean;
}>;

export type TodoRenamedEventPayload = Readonly<{
  todoId: string;
  title: string;
}>;

export type TodoDeletedEventPayload = Readonly<{
  todoId: string;
}>;

/**
 * Domain payloads (value-object-rich, post-decode).
 *
 * These are the shapes consumers see after {@link decodeTodoEvent} has
 * re-validated the wire payload through `TodoId.create` / `TodoTitle.create`.
 * Branded types only live here (and on fresh events emitted by the domain);
 * they never survive a trip through the outbox.
 */
export type TodoCreatedEventPayloadDecoded = Readonly<{
  todoId: TodoId;
  title: TodoTitle;
}>;

export type TodoToggledEventPayloadDecoded = Readonly<{
  todoId: TodoId;
  completed: boolean;
}>;

export type TodoRenamedEventPayloadDecoded = Readonly<{
  todoId: TodoId;
  title: TodoTitle;
}>;

export type TodoDeletedEventPayloadDecoded = Readonly<{
  todoId: TodoId;
}>;

/**
 * Fresh (in-process) Todo events — payloads carry branded value objects.
 *
 * These are produced by {@link TodoEvents} factories inside the domain/
 * application layer. Once serialized to the outbox they flatten to the
 * wire shape and must come back through {@link decodeTodoEvent}.
 */
export type TodoCreatedEvent = DomainEventBase<
  "todo.created",
  TodoCreatedEventPayloadDecoded
>;

export type TodoToggledEvent = DomainEventBase<
  "todo.toggled",
  TodoToggledEventPayloadDecoded
>;

export type TodoRenamedEvent = DomainEventBase<
  "todo.renamed",
  TodoRenamedEventPayloadDecoded
>;

export type TodoDeletedEvent = DomainEventBase<
  "todo.deleted",
  TodoDeletedEventPayloadDecoded
>;

export type TodoEvent =
  | TodoCreatedEvent
  | TodoToggledEvent
  | TodoRenamedEvent
  | TodoDeletedEvent;

/**
 * Alias exposing the event union as the "decoded" type so worker-side code
 * can read the intent clearly: `decodeTodoEvent` yields
 * {@link DecodedTodoEvent}, which is value-object-rich.
 */
export type DecodedTodoEvent = TodoEvent;

/**
 * Factories for fresh in-process `TodoEvent`s.
 *
 * Each factory takes `occurredAt: Date` as a required argument so the domain
 * stays clock-free (see `Clock` port). Callers — typically the application
 * layer or the entity factories in {@link Todo} — resolve `now` once via the
 * Clock port at the entry point and thread that value into both the entity
 * and its emitted events, guaranteeing the entity's `updatedAt` and the
 * event's `occurredAt` agree by construction.
 *
 * The event's `id` is a fresh UUIDv7 minted on every call. We intentionally
 * keep id generation inline (no `IdGenerator` port) for the same reason
 * `TodoId.generate` does: deterministic ids in tests are not currently a
 * requirement, and adding an extra port would be premature.
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
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
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
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
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
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),

  deleted: (todoId: TodoId, occurredAt: Date): TodoDeletedEvent => ({
    id: uuidv7(),
    type: "todo.deleted",
    payload: { todoId },
    occurredAt,
    schemaVersion: TODO_EVENT_SCHEMA_VERSION,
    aggregateId: todoId,
  }),
};

/**
 * Reconstruct a typed `DecodedTodoEvent` from its wire representation.
 *
 * Re-runs the payload through the domain's value-object factories so that
 * consumers always see branded types (`TodoId`, `TodoTitle`) rather than
 * free-form strings. Returns a discriminated-union {@link EventDecodeResult}
 * (`{ ok: true, event } | { ok: false, error }`) instead of throwing so that
 * a single malformed row cannot halt a relay batch: the worker branches on
 * `ok`, skips decode-failed rows with an observability signal, and keeps
 * dispatching the rest of the batch. Value-object factories still throw
 * `BusinessRuleError` internally — we catch and fold them into the `error`
 * channel here so every decode failure flows through the same path.
 */
export const decodeTodoEvent: EventDecoder<TodoEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: EventDecodeMeta,
): EventDecodeResult<TodoEvent> => {
  if (meta.schemaVersion !== TODO_EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: new BusinessRuleError(
        TodoErrorCode.UnsupportedEventSchema,
        `Unsupported todo event schema version: ${meta.schemaVersion}`,
      ),
    };
  }
  try {
    const base = {
      id: meta.id,
      occurredAt: meta.occurredAt,
      schemaVersion: meta.schemaVersion,
      aggregateId: meta.aggregateId,
    };
    switch (type) {
      case "todo.created": {
        const parsed = todoCreatedPayloadSchema.parse(payload);
        const todoId = TodoId.create(parsed.todoId);
        return {
          ok: true,
          event: {
            ...base,
            type: "todo.created",
            payload: { todoId, title: TodoTitle.create(parsed.title) },
          },
        };
      }
      case "todo.toggled": {
        const parsed = todoToggledPayloadSchema.parse(payload);
        const todoId = TodoId.create(parsed.todoId);
        return {
          ok: true,
          event: {
            ...base,
            type: "todo.toggled",
            payload: { todoId, completed: parsed.completed },
          },
        };
      }
      case "todo.renamed": {
        const parsed = todoRenamedPayloadSchema.parse(payload);
        const todoId = TodoId.create(parsed.todoId);
        return {
          ok: true,
          event: {
            ...base,
            type: "todo.renamed",
            payload: { todoId, title: TodoTitle.create(parsed.title) },
          },
        };
      }
      case "todo.deleted": {
        const parsed = todoDeletedPayloadSchema.parse(payload);
        const todoId = TodoId.create(parsed.todoId);
        return {
          ok: true,
          event: {
            ...base,
            type: "todo.deleted",
            payload: { todoId },
          },
        };
      }
      default:
        return {
          ok: false,
          error: new BusinessRuleError(
            TodoErrorCode.UnknownEventType,
            `Unknown todo event type: ${type}`,
          ),
        };
    }
  } catch (error) {
    // Most commonly a `BusinessRuleError` from a value-object factory
    // (corrupt id, malformed title). Anything else is also funnelled here
    // as an `EventDecodeFailed` error so callers see a single failure shape.
    if (error instanceof BusinessRuleError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new BusinessRuleError(
        TodoErrorCode.EventDecodeFailed,
        "Failed to decode todo event payload",
        error,
      ),
    };
  }
};
