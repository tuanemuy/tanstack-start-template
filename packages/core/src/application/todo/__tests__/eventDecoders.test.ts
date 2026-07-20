import { EventId } from "@repo/core/domain/common/event";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId, TodoTitle } from "@repo/core/domain/todo/valueObject";
import { describe, expect, it } from "vitest";
import { todoEventDecoders } from "../eventDecoders";

const T0 = new Date(0);

const todoId = (n: number) =>
  TodoId.create(`00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const eventId = (n: number): EventId =>
  EventId.create(`01950000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

describe("todoEventDecoders", () => {
  it("decodes a valid toggled payload without coercion", () => {
    const id = todoId(1);
    const draft = TodoEvents.toggled(id, false, T0);

    const decoded = todoEventDecoders["todo.toggled"](draft.payload, {
      id: eventId(1),
      occurredAt: draft.occurredAt,
      aggregateId: draft.aggregateId,
    });

    expect(decoded.payload.completed).toBe(false);
  });

  it("rejects string booleans instead of coercing them", () => {
    const id = todoId(2);
    expect(() =>
      todoEventDecoders["todo.toggled"](
        { todoId: id, completed: "false" },
        {
          id: eventId(2),
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });

  it("rejects missing required fields instead of stringifying undefined", () => {
    const id = todoId(3);
    expect(() =>
      todoEventDecoders["todo.created"](
        { todoId: id },
        {
          id: eventId(3),
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });

  it("strips unknown wire fields so additive schema evolution is non-breaking", () => {
    const id = todoId(4);
    const title = TodoTitle.create("forward-compat");
    const decoded = todoEventDecoders["todo.created"](
      { todoId: id, title, futureField: true },
      {
        id: eventId(4),
        occurredAt: new Date(),
        aggregateId: id,
      },
    );

    expect(decoded.payload).toEqual({ todoId: id, title });
    expect(decoded.payload).not.toHaveProperty("futureField");
  });
});
