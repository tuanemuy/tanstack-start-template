import { isConflictError } from "@repo/core/application/errors";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { describe, expect, it } from "vitest";
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
      await todoRepository.insert(todo);
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
        await todoRepository.insert(todo);
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
      await todoRepository.insert(active);
    });

    // Capture v=0 token, advance the row to v=1, then re-use the stale
    // token together with `collectEvents`. The OCC guard must abort the
    // batch, reverting both the would-be UPDATE and the outbox INSERT.
    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: bumped } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bumped, found.expectedVersion);
    });
    // Row is now at v=1; `found.expectedVersion` is stale.

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(
        async ({ todoRepository, collectEvents }) => {
          await todoRepository.save(bumped, found.expectedVersion);
          collectEvents([TodoEvents.toggled(active.id, true, NOW)]);
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);

    // Neither prior UoW collected events (only the inserts ran), so the
    // outbox must be empty — the failing UoW's `collectEvents` was rolled
    // back along with its UPDATE.
    const outboxRows = await container.db.select().from(schema.outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });

  it("attributes an OCC failure to the write that actually conflicted", async () => {
    const container = createTestContainer();
    const { entity: a } = Todo.create(
      { id: nextTodoId(), title: "occ-a" },
      NOW,
    );
    const { entity: b } = Todo.create(
      { id: nextTodoId(), title: "occ-b" },
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const foundA = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(a.id),
    );
    const foundB = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(b.id),
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
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bBumped, foundB.expectedVersion);
    });

    // One UoW, two OCC writes: A (fresh token, would succeed) first, B
    // (stale token) second. The guard that fires is B's, so the surfaced
    // ConflictError must name B — head-handler attribution would name A.
    const { entity: aBumped } = Todo.complete(foundA.entity, NOW);
    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(aBumped, foundA.expectedVersion);
        await todoRepository.save(bBumped, foundB.expectedVersion);
      });
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    expect((caught as Error).message).toContain(b.id);
    expect((caught as Error).message).not.toContain(a.id);

    // The whole batch rolled back: A's fresh-token save must not stick.
    const afterA = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(a.id),
    );
    expect(afterA?.entity.status).toBe("active");
  });

  it("attributes an OCC failure to a stale first write ahead of a fresh second", async () => {
    const container = createTestContainer();
    const { entity: a } = Todo.create(
      { id: nextTodoId(), title: "occ-c" },
      NOW,
    );
    const { entity: b } = Todo.create(
      { id: nextTodoId(), title: "occ-d" },
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const foundA = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(a.id),
    );
    const foundB = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(b.id),
    );
    if (
      !foundA ||
      !foundB ||
      !Todo.isActive(foundA.entity) ||
      !Todo.isActive(foundB.entity)
    ) {
      return;
    }

    const { entity: aBumped } = Todo.complete(foundA.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(aBumped, foundA.expectedVersion);
    });

    const { entity: bBumped } = Todo.complete(foundB.entity, NOW);
    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(aBumped, foundA.expectedVersion);
        await todoRepository.save(bBumped, foundB.expectedVersion);
      });
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    expect((caught as Error).message).toContain(a.id);
    expect((caught as Error).message).not.toContain(b.id);
  });

  it("returns the callback's value on successful commit", async () => {
    const container = createTestContainer();
    const { entity: todo } = Todo.create(
      { id: nextTodoId(), title: "return-value" },
      NOW,
    );

    const id = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => {
        await todoRepository.insert(todo);
        return todo.id;
      },
    );
    expect(id).toBe(todo.id);
  });

  it("supports a read-only UoW (no writes / no batch flush)", async () => {
    const container = createTestContainer();
    const result = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findById(TodoId.create("nonexistent-id")),
    );
    expect(result).toBeNull();
  });
});
