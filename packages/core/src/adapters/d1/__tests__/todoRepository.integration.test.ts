import { isConflictError } from "@repo/core/application/errors";
import type { ExpectedVersion } from "@repo/core/domain/common/transactionalRepository";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { describe, expect, it } from "vitest";
import * as schema from "../schema";
import { createTestContainer } from "./helpers";

describe("D1TodoRepository (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-000000000000`,
    );
  };
  const make = (title: string) => Todo.create({ id: nextTodoId(), title }, NOW);

  it("insert → findById round-trips an ActiveTodo with version=0", async () => {
    const container = createTestContainer();
    const { entity: created } = make("round-trip");

    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(created);
    });

    const loaded = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(created.id),
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
    const container = createTestContainer();
    const { entity: active } = make("lift");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    expect(found).not.toBeNull();
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: completed } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed, found.expectedVersion);
    });

    const loaded = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    expect(loaded?.entity.status).toBe("completed");
    expect(loaded?.entity.version).toBe(1);
    expect(loaded?.expectedVersion).toBe(1);
  });

  it("increments the stored version column on each successful save", async () => {
    const container = createTestContainer();
    const { entity: active } = make("version");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: completed } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed, found.expectedVersion);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError when save reuses a stale token after the row advanced", async () => {
    const container = createTestContainer();
    const { entity: active } = make("stale-save");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    // Capture the v=0 token, then advance the row past it via a real save.
    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: bumped } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bumped, found.expectedVersion);
    });
    // Row is now at v=1; `found.expectedVersion` is the stale v=0 token.

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(bumped, found.expectedVersion);
      });
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    }

    // Row stays at v=1 — the failed batch rolled back.
    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("delete removes the row when the captured version still matches", async () => {
    const container = createTestContainer();
    const { entity: active } = make("delete-ok");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    if (!found) return;
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.delete(found.entity.id, found.expectedVersion);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);
  });

  it("delete raises ConflictError on a forged stale expectedVersion", async () => {
    const container = createTestContainer();
    const { entity: active } = make("delete-stale");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        // Forge a token that does not match the row (v=0). Production code
        // cannot reach this state without going through `findById`;
        // the cast is the explicit "I am bypassing the contract" marker.
        await todoRepository.delete(active.id, 99 as ExpectedVersion<Todo>);
      });
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
  });

  it("findPage returns paged results in (createdAt desc, id desc) order", async () => {
    const container = createTestContainer();
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");

    const { entity: a } = Todo.create(
      { id: nextTodoId(), title: "a" },
      earlier,
    );
    const { entity: b } = Todo.create({ id: nextTodoId(), title: "b" }, later);

    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const page = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 1, limit: 10 }),
    );
    expect(page.count).toBe(2);
    expect(page.items.map((t) => t.title)).toEqual(["b", "a"]);
  });
});
