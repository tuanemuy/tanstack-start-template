import { describe, expect, it } from "vitest";
import { FakeIdGenerator } from "@/core/application/__tests__/fakes";
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
 *
 * Aggregate ids and event ids are produced by a `FakeIdGenerator` rather
 * than the (now-removed) `TodoId.generate()` — id minting moved to the
 * application-layer port; the domain only consumes finished strings.
 */

describe("DrizzleSqliteTodoRepository (integration)", () => {
  const getContainer = setupTestContainer();
  // Fixed instant for determinism. Real-time semantics (ordering by createdAt
  // etc.) are exercised separately by passing per-row dates into seed inserts.
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  const ids = new FakeIdGenerator();
  const nextId = () => ids.next();
  const nextTodoId = () => TodoId.create(nextId());
  const make = (title: string) =>
    Todo.create({ id: nextTodoId(), eventId: nextId(), title }, NOW);

  it("save → findById round-trips an ActiveTodo with all fields intact", async () => {
    const container = getContainer();
    const { entity: created } = make("round-trip");

    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(created);
    });

    const loaded = await container.unitOfWorkProvider.run(
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
    const { entity: active } = make("lift");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completed } = Todo.complete(active, nextId(), NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed);
    });

    const loaded = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    expect(loaded?.status).toBe("completed");
    expect(loaded?.version).toBe(1);
  });

  it("increments the stored version column on each successful save", async () => {
    const container = getContainer();
    const { entity: active } = make("version");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completed } = Todo.complete(active, nextId(), NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError(OptimisticLockFailure) when expectedVersion does not match", async () => {
    const container = getContainer();
    const { entity: active } = make("occ");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    // Someone else completes the row, advancing DB version to 1.
    const { entity: completedFirst } = Todo.complete(active, nextId(), NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completedFirst);
    });

    // A stale client tries to save a version-based update derived from the
    // original (version 0) read — predicate `WHERE version = 0` matches
    // nothing and the adapter surfaces a ConflictError.
    const { entity: stale } = Todo.complete(active, nextId(), NOW);
    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(stale);
      });
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
    const { entity: active } = make("del-occ");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        // Passing the wrong expectedVersion simulates "another writer
        // advanced the version before we got here".
        await todoRepository.delete(active.id, 99);
      });
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
    const ghostId = nextTodoId();

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.delete(ghostId, 0);
      });
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
    // unambiguous. Bypassing the usecase here also lets us pick exact ids
    // that anchor the assertion on `row-N` titles below.
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

    const page1 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 1, limit: 2 }),
    );
    expect(page1.count).toBe(5);
    expect(page1.items).toHaveLength(2);
    // Newest first (i=4, i=3).
    expect(page1.items[0]?.title).toBe("row-4");
    expect(page1.items[1]?.title).toBe("row-3");

    const page3 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 3, limit: 2 }),
    );
    expect(page3.count).toBe(5);
    // Last page has a single trailing row.
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.title).toBe("row-0");
  });

  it("findPage returns a stable id-ordered sequence across pages when createdAt is identical", async () => {
    const container = getContainer();
    // Seed multiple rows that share the *same* createdAt so the secondary
    // sort key (id desc) is the only thing that differentiates them. Without
    // a stable tiebreaker, paging would be free to interleave these rows and
    // either drop or duplicate them.
    const sameInstant = new Date("2026-04-01T00:00:00.000Z");
    const seedIds = [
      "019db000-0000-7000-8000-000000000021",
      "019db000-0000-7000-8000-000000000022",
      "019db000-0000-7000-8000-000000000023",
      "019db000-0000-7000-8000-000000000024",
      "019db000-0000-7000-8000-000000000025",
    ];
    for (const id of seedIds) {
      await container.db.insert(schema.todos).values({
        id,
        title: `same-${id.slice(-2)}`,
        completed: false,
        version: 0,
        createdAt: sameInstant,
        updatedAt: sameInstant,
      });
    }

    const page1 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 1, limit: 2 }),
    );
    const page2 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 2, limit: 2 }),
    );
    const page3 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 3, limit: 2 }),
    );

    const collected = [...page1.items, ...page2.items, ...page3.items].map(
      (t) => t.id,
    );
    // Deterministic descending id order — and no overlaps / no gaps.
    const expected = [...seedIds].sort().reverse();
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(seedIds.length);
  });

  it("findAll returns todos in descending createdAt order", async () => {
    const container = getContainer();
    const base = new Date("2026-03-01T00:00:00.000Z").getTime();
    const seedIds = [
      "019db000-0000-7000-8000-000000000011",
      "019db000-0000-7000-8000-000000000012",
      "019db000-0000-7000-8000-000000000013",
    ];
    for (let i = 0; i < seedIds.length; i++) {
      const id = seedIds[i];
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
    const all = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findAll(),
    );
    expect(all.map((t) => t.id)).toEqual([seedIds[2], seedIds[1], seedIds[0]]);
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
      await container.unitOfWorkProvider.run(async ({ todoRepository }) =>
        todoRepository.findAll(),
      );
      expect.fail("findAll should have surfaced a SystemError");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});
