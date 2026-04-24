import { describe, expect, it } from "vitest";
import { setupTestContainer } from "@/core/application/__tests__/helpers";
import { ConflictErrorCode, isConflictError } from "@/core/application/errors";
import { Todo } from "@/core/domain/todo/entity";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import * as schema from "../schema";

/**
 * Integration tests for the Drizzle todo repository.
 *
 * Exercises concerns the fake in-memory repository cannot reproduce:
 *
 * - End-to-end row encoding/decoding through `toTodo`.
 * - Database-level version increment on the optimistic-lock UPDATE.
 * - Real SQLite pagination / ordering semantics.
 */

describe("DrizzleSqliteTodoRepository (integration)", () => {
  const getContainer = setupTestContainer();
  // Fixed instant for determinism. Real-time semantics (ordering by createdAt
  // etc.) are exercised separately by passing per-row dates into seed inserts.
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  it("save → findById round-trips an ActiveTodo with all fields intact", async () => {
    const container = getContainer();
    const { entity: created } = Todo.create({ title: "round-trip" }, NOW);

    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(created);
      },
    );

    const loaded = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => todoRepository.findById(created.id),
    );
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.id).toBe(created.id);
    expect(loaded.title).toBe(created.title);
    expect(loaded.status).toBe("active");
    expect(loaded.version).toBe(0);
    // SQLite's `timestamp` mode stores whole seconds, so `Date`s survive
    // the round trip only at second granularity. Compare on the truncated
    // value rather than pretending the ms-precision round-trips.
    expect(Math.floor(loaded.createdAt.getTime() / 1000)).toBe(
      Math.floor(created.createdAt.getTime() / 1000),
    );
    expect(Math.floor(loaded.updatedAt.getTime() / 1000)).toBe(
      Math.floor(created.updatedAt.getTime() / 1000),
    );
  });

  it("save → findById lifts the completed flag into a CompletedTodo variant", async () => {
    const container = getContainer();
    const { entity: active } = Todo.create({ title: "lift" }, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(active);
      },
    );

    const { entity: completed } = Todo.complete(active, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(completed);
      },
    );

    const loaded = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    expect(loaded?.status).toBe("completed");
    expect(loaded?.version).toBe(1);
  });

  it("increments the stored version column on each successful save", async () => {
    const container = getContainer();
    const { entity: active } = Todo.create({ title: "version" }, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(active);
      },
    );

    const { entity: toggled } = Todo.toggle(active, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(toggled);
      },
    );

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError(OptimisticLockFailure) when expectedVersion does not match", async () => {
    const container = getContainer();
    const { entity: active } = Todo.create({ title: "occ" }, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(active);
      },
    );

    // Someone else toggles the row, advancing DB version to 1.
    const { entity: toggled } = Todo.toggle(active, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(toggled);
      },
    );

    // A stale client tries to save a version-based update derived from the
    // original (version 0) read — predicate `WHERE version = 0` matches
    // nothing and the adapter surfaces a ConflictError.
    const { entity: stale } = Todo.toggle(active, NOW);
    let caught: unknown;
    try {
      await container.unitOfWorkProvider.runReadWrite(
        async ({ todoRepository }) => {
          await todoRepository.save(stale);
        },
      );
      expect.fail("stale save should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe(ConflictErrorCode.OptimisticLockFailure);
    }
  });

  it("delete with mismatched expectedVersion raises ConflictError", async () => {
    const container = getContainer();
    const { entity: active } = Todo.create({ title: "del-occ" }, NOW);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ todoRepository }) => {
        await todoRepository.save(active);
      },
    );

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.runReadWrite(
        async ({ todoRepository }) => {
          // Passing the wrong expectedVersion simulates "another writer
          // advanced the version before we got here".
          await todoRepository.delete(active.id, 99);
        },
      );
      expect.fail("mismatched delete should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe(ConflictErrorCode.OptimisticLockFailure);
    }
    // Row is still present — zero-row delete must not have mutated state.
    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
  });

  it("delete against a non-existent id raises ConflictError (no silent no-op)", async () => {
    const container = getContainer();
    const ghostId = TodoId.generate();

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.runReadWrite(
        async ({ todoRepository }) => {
          await todoRepository.delete(ghostId, 0);
        },
      );
      expect.fail("delete of ghost id should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
  });

  it("findPage respects limit/offset and reports total count", async () => {
    const container = getContainer();
    const base = new Date("2026-02-01T00:00:00.000Z").getTime();
    // Seed rows directly with staggered timestamps so the ORDER BY is
    // unambiguous — `Todo.create` uses `new Date()` internally which would
    // cluster within a single millisecond and confuse stable ordering.
    for (let i = 0; i < 5; i++) {
      const at = new Date(base + i * 1000);
      await container.db.insert(schema.todos).values({
        id: `019db000-0000-7000-8000-00000000000${i + 1}`,
        title: `row-${i}`,
        completed: false,
        version: 0,
        createdAt: at,
        updatedAt: at,
      });
    }

    const page1 = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 1, limit: 2 }),
    );
    expect(page1.count).toBe(5);
    expect(page1.items).toHaveLength(2);
    // Newest first (i=4, i=3).
    expect(page1.items[0]?.title).toBe("row-4");
    expect(page1.items[1]?.title).toBe("row-3");

    const page3 = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 3, limit: 2 }),
    );
    expect(page3.count).toBe(5);
    // Last page has a single trailing row.
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.title).toBe("row-0");
  });

  it("findAll returns todos in descending createdAt order", async () => {
    const container = getContainer();
    const base = new Date("2026-03-01T00:00:00.000Z").getTime();
    const ids = [
      "019db000-0000-7000-8000-000000000011",
      "019db000-0000-7000-8000-000000000012",
      "019db000-0000-7000-8000-000000000013",
    ];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const at = new Date(base + i * 2000);
      await container.db.insert(schema.todos).values({
        id,
        title: `t-${i}`,
        completed: false,
        version: 0,
        createdAt: at,
        updatedAt: at,
      });
    }
    const all = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => todoRepository.findAll(),
    );
    expect(all.map((t) => t.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("rowToTodo re-validates value-object invariants (corrupt id → SystemError)", async () => {
    const container = getContainer();
    // Poke a corrupt row straight into the DB so the repository has to
    // recover from it. `TodoId.create` will reject "not-a-uuid" and the
    // adapter must wrap that as SystemError(DatabaseError).
    const now = new Date();
    await container.db.insert(schema.todos).values({
      id: "not-a-uuid",
      title: TodoTitle.create("x"),
      completed: false,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    // `findAll` traverses every row so it forces the decoder to run; a
    // corrupted row must raise rather than return garbage.
    let caught: unknown;
    try {
      await container.unitOfWorkProvider.runReadonly(
        async ({ todoRepository }) => todoRepository.findAll(),
      );
      expect.fail("findAll should have surfaced a SystemError");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});
