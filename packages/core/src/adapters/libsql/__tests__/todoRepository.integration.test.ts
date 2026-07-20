import { isConflictError } from "@repo/core/application/errors";
import type { ExpectedVersion } from "@repo/core/domain/common/transactionalRepository";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

describe("LibsqlTodoRepository (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-000000000000`,
    );
  };
  const make = (title: string) => Todo.create({ id: nextTodoId(), title }, NOW);

  let container: TestContainer | null = null;
  const openContainer = async () => {
    container = await createTestContainer();
    return container;
  };
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("insert → findById round-trips an ActiveTodo with version=0", async () => {
    const c = await openContainer();
    const { entity: created } = make("round-trip");

    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(created);
    });

    const loaded = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(created.id),
    );
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.entity.id).toBe(created.id);
    expect(loaded.entity.title).toBe(created.title);
    expect(loaded.entity.status).toBe("active");
    expect(loaded.entity.version).toBe(0);
    expect(loaded.expectedVersion).toBe(0);
  });

  it("save lifts the status into a CompletedTodo variant", async () => {
    const c = await openContainer();
    const { entity: active } = make("lift");
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(active.id),
    );
    expect(found).not.toBeNull();
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: completed } = Todo.complete(found.entity, NOW);
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed, found.expectedVersion);
    });

    const loaded = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(active.id),
    );
    expect(loaded?.entity.status).toBe("completed");
    expect(loaded?.entity.version).toBe(1);
    expect(loaded?.expectedVersion).toBe(1);
  });

  it("increments the stored version column on each successful save", async () => {
    const c = await openContainer();
    const { entity: active } = make("version");
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: completed } = Todo.complete(found.entity, NOW);
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed, found.expectedVersion);
    });

    const rows = await c.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError when save reuses a stale token after the row advanced", async () => {
    const c = await openContainer();
    const { entity: active } = make("stale-save");
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
      await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(bumped, found.expectedVersion);
      });
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    }

    const rows = await c.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("delete removes the row when the captured version still matches", async () => {
    const c = await openContainer();
    const { entity: active } = make("delete-ok");
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findById(active.id),
    );
    if (!found) return;
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.delete(found.entity.id, found.expectedVersion);
    });

    const rows = await c.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);
  });

  it("delete raises ConflictError on a forged stale expectedVersion", async () => {
    const c = await openContainer();
    const { entity: active } = make("delete-stale");
    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    let caught: unknown;
    try {
      await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.delete(active.id, 99 as ExpectedVersion<Todo>);
      });
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);

    const rows = await c.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
  });

  it("findPage returns paged results in (createdAt desc, id desc) order", async () => {
    const c = await openContainer();
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");

    const { entity: a } = Todo.create(
      { id: nextTodoId(), title: "a" },
      earlier,
    );
    const { entity: b } = Todo.create({ id: nextTodoId(), title: "b" }, later);

    await c.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const page = await c.unitOfWorkProvider.run(async ({ todoRepository }) =>
      todoRepository.findPage({ page: 1, limit: 10 }),
    );
    expect(page.count).toBe(2);
    expect(page.items.map((t) => t.title)).toEqual(["b", "a"]);
  });
});
