import { describe, expect, it } from "vitest";
import { EventId } from "@/core/domain/common/event";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { todoEventDecoders } from "../eventDecoders";

const T0 = new Date(0);

const todoId = (n: number) =>
  TodoId.create(`00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const eventId = (n: number): EventId =>
  EventId.create(`01950000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

describe("todoEventDecoders", () => {
  it("decodes a valid toggled payload without coercion", () => {
    const id = todoId(1);
    const event = TodoEvents.toggled(eventId(1), id, false, T0);

    const decoded = todoEventDecoders["todo.toggled"](event.payload, {
      id: event.id,
      occurredAt: event.occurredAt,
      aggregateId: event.aggregateId,
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

  it("rejects extra wire fields", () => {
    const id = todoId(4);
    const title = TodoTitle.create("strict");
    expect(() =>
      todoEventDecoders["todo.created"](
        { todoId: id, title, extra: true },
        {
          id: eventId(4),
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });
});
