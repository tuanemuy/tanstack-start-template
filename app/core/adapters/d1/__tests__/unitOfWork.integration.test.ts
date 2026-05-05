import { describe, expect, it } from "vitest";
import { isConflictError } from "@/core/application/errors";
import { Todo } from "@/core/domain/todo/entity";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId } from "@/core/domain/todo/valueObject";
import * as schema from "../schema";
import { createTestContainer } from "./helpers";

// Drives the deferred-batch contract end to end: writes don't materialize
// until `run()` returns, outbox events ride the same atomic flush, and an
// OCC failure from any participating write rolls everything back —
// aggregate AND outbox.
describe("D1UnitOfWorkProvider (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-100000000000`,
    );
  };

  it("defers all writes until run() resolves (no row visible mid-callback)", async () => {
    const container = createTestContainer();
    const { entity: todo } = Todo.create(
      { id: nextTodoId(), title: "deferred" },
      NOW,
    );

    let midRunRows: unknown[] = [];
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(todo);
      // Side-channel read against the binding directly: the batch has
      // not been flushed yet, so the row must not be visible.
      midRunRows = await container.db.select().from(schema.todos);
    });

    expect(midRunRows).toHaveLength(0);

    const afterRows = await container.db.select().from(schema.todos);
    expect(afterRows).toHaveLength(1);
  });

  it("persists collected outbox events atomically with the aggregate write", async () => {
    const container = createTestContainer();
    const { entity: todo, eventDrafts } = Todo.create(
      { id: nextTodoId(), title: "with-events" },
      NOW,
    );

    await container.unitOfWorkProvider.run(
      async ({ todoRepository, collectEvents }) => {
        await todoRepository.save(todo);
        collectEvents(eventDrafts);
      },
    );

    const todoRows = await container.db.select().from(schema.todos);
    const outboxRows = await container.db.select().from(schema.outboxEvents);
    expect(todoRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventType).toBe("todo.created");
    expect(outboxRows[0]?.aggregateId).toBe(todo.id);
  });

  it("rolls back outbox events when the aggregate write hits an OCC failure", async () => {
    const container = createTestContainer();
    const { entity: active } = Todo.create(
      { id: nextTodoId(), title: "occ-rollback" },
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    // Stale save attempt: claims version 5 on a row that's at 0. The
    // OCC guard must abort the batch, reverting both the would-be
    // UPDATE and the `collectEvents` outbox INSERT.
    const stale = Todo.reconstruct({
      id: active.id,
      title: active.title,
      status: "active",
      version: 5,
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
    });

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(
        async ({ todoRepository, collectEvents }) => {
          await todoRepository.save(stale);
          collectEvents([TodoEvents.toggled(active.id, true, NOW)]);
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);

    const outboxRows = await container.db.select().from(schema.outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });

  it("returns the callback's value on successful commit", async () => {
    const container = createTestContainer();
    const { entity: todo } = Todo.create(
      { id: nextTodoId(), title: "return-value" },
      NOW,
    );

    const id = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => {
        await todoRepository.save(todo);
        return todo.id;
      },
    );
    expect(id).toBe(todo.id);
  });

  it("supports a read-only UoW (no writes / no batch flush)", async () => {
    const container = createTestContainer();
    const result = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById("nonexistent-id"),
    );
    expect(result).toBeNull();
  });
});
