import { describe, expect, it } from "vitest";
import { decodeTodoEvent, TodoEvents } from "../events";
import { TodoId, TodoTitle } from "../valueObject";

const T0 = new Date(0);

describe("decodeTodoEvent", () => {
  it("decodes a valid toggled payload without coercion", () => {
    const id = TodoId.generate();
    const event = TodoEvents.toggled(id, false, T0);

    const decoded = decodeTodoEvent(event.type, event.payload, {
      id: event.id,
      occurredAt: event.occurredAt,
      aggregateId: event.aggregateId,
    });

    expect(decoded.type).toBe("todo.toggled");
    if (decoded.type !== "todo.toggled") return;
    expect(decoded.payload.completed).toBe(false);
  });

  it("rejects string booleans instead of coercing them", () => {
    const id = TodoId.generate();
    expect(() =>
      decodeTodoEvent(
        "todo.toggled",
        { todoId: id, completed: "false" },
        {
          id: "01950000-0000-7000-8000-000000000001",
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });

  it("rejects missing required fields instead of stringifying undefined", () => {
    const id = TodoId.generate();
    expect(() =>
      decodeTodoEvent(
        "todo.created",
        { todoId: id },
        {
          id: "01950000-0000-7000-8000-000000000002",
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });

  it("rejects extra wire fields", () => {
    const id = TodoId.generate();
    const title = TodoTitle.create("strict");
    expect(() =>
      decodeTodoEvent(
        "todo.created",
        { todoId: id, title, extra: true },
        {
          id: "01950000-0000-7000-8000-000000000003",
          occurredAt: new Date(),
          aggregateId: id,
        },
      ),
    ).toThrow();
  });
});
