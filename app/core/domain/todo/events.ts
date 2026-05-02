import { SystemError, SystemErrorCode } from "@/core/application/errors";
import type {
  DomainEventBase,
  EventDecoder,
  EventId,
} from "@/core/domain/common/event";
import { TodoId, TodoTitle } from "./valueObject";

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
    id: EventId,
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
    id: EventId,
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
    id: EventId,
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
    id: EventId,
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

// Decode failures are data-integrity / infra-class problems (a corrupt or
// schema-skewed outbox row), not business-rule violations — surface them
// as `SystemError(DatabaseError)` so logs / kind-routing classify them
// alongside other infrastructure failures.
function rejectPayload(eventType: string, message: string): never {
  throw new SystemError(
    SystemErrorCode.DatabaseError,
    `Invalid payload for ${eventType}: ${message}`,
  );
}

function assertExactKeys(
  eventType: string,
  payload: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      rejectPayload(eventType, `unexpected field "${key}"`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(payload, key)) {
      rejectPayload(eventType, `missing field "${key}"`);
    }
  }
}

function takeString(
  eventType: string,
  payload: Record<string, unknown>,
  key: string,
): string {
  const v = payload[key];
  if (typeof v !== "string") {
    rejectPayload(eventType, `field "${key}" must be a string`);
  }
  return v;
}

function takeBoolean(
  eventType: string,
  payload: Record<string, unknown>,
  key: string,
): boolean {
  const v = payload[key];
  if (typeof v !== "boolean") {
    rejectPayload(eventType, `field "${key}" must be a boolean`);
  }
  return v;
}

export type TodoEventDecoders = {
  readonly [K in TodoEvent["type"]]: EventDecoder<
    Extract<TodoEvent, { type: K }>
  >;
};

export const todoEventDecoders: TodoEventDecoders = {
  "todo.created": (_type, payload, meta) => {
    assertExactKeys("todo.created", payload, ["todoId", "title"]);
    const todoId = takeString("todo.created", payload, "todoId");
    const title = takeString("todo.created", payload, "title");
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.created",
      payload: {
        todoId: TodoId.create(todoId),
        title: TodoTitle.create(title),
      },
    };
  },
  "todo.toggled": (_type, payload, meta) => {
    assertExactKeys("todo.toggled", payload, ["todoId", "completed"]);
    const todoId = takeString("todo.toggled", payload, "todoId");
    const completed = takeBoolean("todo.toggled", payload, "completed");
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.toggled",
      payload: {
        todoId: TodoId.create(todoId),
        completed,
      },
    };
  },
  "todo.renamed": (_type, payload, meta) => {
    assertExactKeys("todo.renamed", payload, ["todoId", "title"]);
    const todoId = takeString("todo.renamed", payload, "todoId");
    const title = takeString("todo.renamed", payload, "title");
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.renamed",
      payload: {
        todoId: TodoId.create(todoId),
        title: TodoTitle.create(title),
      },
    };
  },
  "todo.deleted": (_type, payload, meta) => {
    assertExactKeys("todo.deleted", payload, ["todoId"]);
    const todoId = takeString("todo.deleted", payload, "todoId");
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type: "todo.deleted",
      payload: { todoId: TodoId.create(todoId) },
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
    throw new SystemError(
      SystemErrorCode.DatabaseError,
      `Unknown todo event type: ${type}`,
    );
  }
  return todoEventDecoders[type](type, payload, meta);
};
