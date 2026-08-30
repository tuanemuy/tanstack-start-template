import { isConflictError } from "@repo/core/application/errors";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

describe("LibsqlUnitOfWorkProvider (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-100000000000`,
    );
  };

  let container: TestContainer | null = null;
  const openContainer = async () => {
    container = await createTestContainer();
    return container;
  };
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("defers all writes until run() resolves (no row visible mid-callback)", async () => {
    const c = await openContainer();
    const { entity: todo } = Todo.create(
      { id: nextTodoId(), title: "deferred" },
      NOW,
    );

    let midRunRows: unknown[] = [];
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(todo);
      // Side-channel read against the outer handle: the transaction has
      // not been opened yet, so the row must not be visible.
      midRunRows = await c.db.select().from(schema.todos);
    });

    expect(midRunRows).toHaveLength(0);

    const afterRows = await c.db.select().from(schema.todos);
    expect(afterRows).toHaveLength(1);
  });

  it("persists collected outbox events atomically with the aggregate write", async () => {
    const c = await openContainer();
    const { entity: todo, eventDrafts } = Todo.create(
      { id: nextTodoId(), title: "with-events" },
      NOW,
    );

    await c.unitOfWorkProvider.run(
      async ({ todoRepository, collectEvents }) => {
        await todoRepository.insert(todo);
        collectEvents(eventDrafts);
      },
    );

    const todoRows = await c.db.select().from(schema.todos);
    const outboxRows = await c.db.select().from(schema.outboxEvents);
    expect(todoRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventType).toBe("todo.created");
    expect(outboxRows[0]?.aggregateId).toBe(todo.id);
  });

  it("rolls back outbox events when the aggregate write hits an OCC failure", async () => {
    const c = await openContainer();
    const { entity: active } = Todo.create(
      { id: nextTodoId(), title: "occ-rollback" },
      NOW,
    );
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: bumped } = Todo.complete(found.entity, NOW);
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bumped, found.expectedVersion);
    });

    let caught: unknown;
    try {
      await c.unitOfWorkProvider.run(
        async ({ todoRepository, collectEvents }) => {
          await todoRepository.save(bumped, found.expectedVersion);
          collectEvents([TodoEvents.toggled(active.id, true, NOW)]);
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);

    // Prior UoWs did not collect events; the failing UoW's `collectEvents`
    // must have rolled back along with its UPDATE.
    const outboxRows = await c.db.select().from(schema.outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });

  // Parity with the D1 adapter's attribution test: with two OCC writes
  // in one UoW, the surfaced ConflictError must name the write that
  // actually conflicted, regardless of its position in the batch.
  it("attributes an OCC failure to the write that actually conflicted", async () => {
    const c = await openContainer();
    const { entity: a } = Todo.create(
      { id: nextTodoId(), title: "occ-a" },
      NOW,
    );
    const { entity: b } = Todo.create(
      { id: nextTodoId(), title: "occ-b" },
      NOW,
    );
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const foundA = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(a.id),
    );
    const foundB = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(b.id),
    );
    if (
      !foundA ||
      !foundB ||
      !Todo.isActive(foundA.entity) ||
      !Todo.isActive(foundB.entity)
    ) {
      return;
    }

    // Advance B out-of-band so B's token goes stale while A's stays fresh.
    const { entity: bBumped } = Todo.complete(foundB.entity, NOW);
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bBumped, foundB.expectedVersion);
    });

    const { entity: aBumped } = Todo.complete(foundA.entity, NOW);
    let caught: unknown;
    try {
      await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(aBumped, foundA.expectedVersion);
        await todoRepository.save(bBumped, foundB.expectedVersion);
      });
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    expect((caught as Error).message).toContain(b.id);
    expect((caught as Error).message).not.toContain(a.id);
  });

  it("returns the callback's value on successful commit", async () => {
    const c = await openContainer();
    const { entity: todo } = Todo.create(
      { id: nextTodoId(), title: "return-value" },
      NOW,
    );

    const id = await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(todo);
      return todo.id;
    });
    expect(id).toBe(todo.id);
  });

  it("supports a read-only UoW (no writes / no transaction)", async () => {
    const c = await openContainer();
    const result = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(TodoId.create("nonexistent-id")),
    );
    expect(result).toBeNull();
  });
});
