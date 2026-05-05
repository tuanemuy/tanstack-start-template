import { describe, expect, it } from "vitest";
import { isConflictError } from "@/core/application/errors";
import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
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

  it("save → findById round-trips an ActiveTodo", async () => {
    const container = createTestContainer();
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
  });

  it("save → findById lifts the status into a CompletedTodo variant", async () => {
    const container = createTestContainer();
    const { entity: active } = make("lift");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completed } = Todo.complete(active, NOW);
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
    const container = createTestContainer();
    const { entity: active } = make("version");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    const { entity: completed } = Todo.complete(active, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("raises ConflictError when save sees a stale version", async () => {
    const container = createTestContainer();
    const { entity: active } = make("stale-save");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    // Hand-craft a stale `Todo` claiming to be at version 5 when the row
    // is actually at 0 → the OCC guard inside the batch must fire.
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
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(stale);
      });
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    }

    // Row must be unchanged — the failed batch rolled back.
    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(0);
  });

  it("delete removes the row when the expected version matches", async () => {
    const container = createTestContainer();
    const { entity: active } = make("delete-ok");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.delete(active.id, 0);
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);
  });

  it("delete raises ConflictError on a stale expectedVersion", async () => {
    const container = createTestContainer();
    const { entity: active } = make("delete-stale");
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(active);
    });

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.delete(active.id, 99);
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
      await todoRepository.save(a);
      await todoRepository.save(b);
    });

    const page = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) =>
        todoRepository.findPage({ page: 1, limit: 10 }),
    );
    expect(page.count).toBe(2);
    expect(page.items.map((t) => t.title)).toEqual(["b", "a"]);
  });
});
