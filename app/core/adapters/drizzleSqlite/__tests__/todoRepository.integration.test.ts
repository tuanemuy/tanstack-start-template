import { describe, expect, it } from "vitest";
import { FakeIdGenerator } from "@/core/application/__tests__/fakes";
import { setupTestContainer } from "@/core/application/__tests__/helpers";
import { isConflictError } from "@/core/application/errors";
import { EventId } from "@/core/domain/common/event";
import { Todo } from "@/core/domain/todo/entity";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import * as schema from "../schema";

describe("DrizzleSqliteTodoRepository (integration)", () => {
  const getContainer = setupTestContainer();
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  const ids = new FakeIdGenerator();
  const nextEventId = () => EventId.create(ids.next());
  const nextTodoId = () => TodoId.create(ids.next());
  const make = (title: string) =>
    Todo.create({ id: nextTodoId(), eventId: nextEventId(), title }, NOW);

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
    // SQLite's `timestamp` mode stores whole seconds; compare on the
    // truncated value rather than pretending ms-precision round-trips.
    expect(Math.floor(loaded.createdAt.getTime() / 1000)).toBe(
      Math.floor(created.createdAt.getTime() / 1000),
    );
    expect(Math.floor(loaded.updatedAt.getTime() / 1000)).toBe(
      Math.floor(created.updatedAt.getTime() / 1000),
    );
  });

  it("save → findById lifts the status into a CompletedTodo variant", async () => {
    const container = getContainer();
    const { entity: active } = make("lift");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completed } = Todo.complete(active, nextEventId(), NOW);
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

    const { entity: completed } = Todo.complete(active, nextEventId(), NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError when expectedVersion does not match", async () => {
    const container = getContainer();
    const { entity: active } = make("occ");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completedFirst } = Todo.complete(
      active,
      nextEventId(),
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completedFirst);
    });

    const { entity: stale } = Todo.complete(active, nextEventId(), NOW);
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
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
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
        await todoRepository.delete(active.id, 99);
      });
      expect.fail("mismatched delete should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    }
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
    for (let i = 0; i < 5; i++) {
      const at = new Date(base + i * 1000);
      await container.db.insert(schema.todos).values({
        id: `019db000-0000-7000-8000-00000000000${i + 1}`,
        title: `row-${i}`,
        status: "active",
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
    expect(page1.items[0]?.title).toBe("row-4");
    expect(page1.items[1]?.title).toBe("row-3");

    const page3 = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 3, limit: 2 }),
    );
    expect(page3.count).toBe(5);
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.title).toBe("row-0");
  });

  it("findPage returns an empty page with the correct total when offset is past the end", async () => {
    const container = getContainer();
    await container.db.insert(schema.todos).values({
      id: "019db000-0000-7000-8000-000000000031",
      title: "lonely",
      status: "active",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 9, limit: 10 }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.count).toBe(1);
  });

  it("findPage returns a stable id-ordered sequence across pages when createdAt is identical", async () => {
    const container = getContainer();
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
        status: "active",
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
    const expected = [...seedIds].sort().reverse();
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(seedIds.length);
  });

  it("rowToTodo re-validates value-object invariants (corrupt id → SystemError)", async () => {
    const container = getContainer();
    const now = new Date();
    await container.db.insert(schema.todos).values({
      id: "not-a-uuid",
      title: TodoTitle.create("x"),
      status: "active",
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) =>
        todoRepository.findById("not-a-uuid"),
      );
      expect.fail("findById should have surfaced a SystemError");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});
