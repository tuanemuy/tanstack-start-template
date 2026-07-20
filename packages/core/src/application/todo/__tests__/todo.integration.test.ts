import * as schema from "@repo/core/adapters/d1/schema";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { describe, expect, it } from "vitest";
import { setupTestContainer } from "../../__tests__/helpers";
import { isConflictError, isNotFoundError } from "../../errors";
import { changeTodoStatus } from "../changeTodoStatus";
import { createTodo } from "../createTodo";
import { deleteTodo } from "../deleteTodo";
import { listTodos } from "../listTodos";

describe("createTodo integration", () => {
  const getContainer = setupTestContainer();

  it("commits todo + outbox entry in the same transaction", async () => {
    const container = getContainer();

    const { todo } = await createTodo({
      container,
      input: { title: "atomic" },
    });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(todo.id);

    const outbox = await container.db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe("todo.created");
    expect(outbox[0]?.processedAt).toBeNull();
  });
});

describe("concurrent deleteTodo", () => {
  const getContainer = setupTestContainer();

  it("only one concurrent delete succeeds; the other rejects with a NotFound or Conflict error", async () => {
    const container = getContainer();
    const { todo } = await createTodo({
      container,
      input: { title: "race" },
    });

    const results = await Promise.allSettled([
      deleteTodo({ container, input: { id: todo.id } }),
      deleteTodo({ container, input: { id: todo.id } }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0];
    if (rejection && rejection.status === "rejected") {
      // The deferred-batch UoW lets both UoWs see the row at find time,
      // then surfaces the racing loser one of two ways depending on
      // batch interleaving:
      //   - the loser's UoW finds nothing  → NotFoundError surfaced
      //     by the usecase                   (interleaving A);
      //   - the loser hits the OCC guard   → ConflictError on the
      //     `_occ_guard` CHECK violation     (interleaving B).
      // Both indicate "the row was already deleted by the racing peer".
      // The non-determinism is inherent to D1's deferred-batch model
      // (no interactive transactions); the OCC token contract still
      // holds — both UoWs go through `findById` and the loser
      // is caught either before or at flush time.
      const reason = rejection.reason;
      expect(isNotFoundError(reason) || isConflictError(reason)).toBe(true);
    }

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);
  });
});

describe("concurrent changeTodoStatus", () => {
  const getContainer = setupTestContainer();

  it("two concurrent change-status commands either both succeed or one raises ConflictError", async () => {
    const container = getContainer();
    const { todo } = await createTodo({
      container,
      input: { title: "race-status" },
    });

    const results = await Promise.allSettled([
      changeTodoStatus({
        container,
        input: { id: todo.id, status: "completed" },
      }),
      changeTodoStatus({
        container,
        input: { id: todo.id, status: "completed" },
      }),
    ]);

    // Without an OCC retry layer, one writer may lose to optimistic-lock; the
    // other must always succeed and the row must end up completed.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.version).toBe(1);
  });

  it("repository rejects with ConflictError when saving with a stale captured token", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "stale-read" },
    });

    const staleId = TodoId.create(created.id);
    const stale = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => {
        const found = await todoRepository.findById(staleId);
        if (!found) throw new Error("expected todo to exist");
        return found;
      },
    );
    expect(stale.entity.version).toBe(0);
    expect(stale.expectedVersion).toBe(0);

    await changeTodoStatus({
      container,
      input: { id: created.id, status: "completed" },
    });

    if (!Todo.isActive(stale.entity)) {
      expect.fail("expected stale read to still be active");
      return;
    }
    const { entity: staleMutation } = Todo.complete(
      stale.entity,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    let caught: unknown;
    let resolved = false;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(staleMutation, stale.expectedVersion);
      });
      resolved = true;
    } catch (error) {
      caught = error;
    }
    if (resolved) expect.fail("stale save should have thrown");
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    }

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.version).toBe(1);
  });
});

describe("listTodos", () => {
  const getContainer = setupTestContainer();

  it("returns todos ordered by createdAt descending", async () => {
    const container = getContainer();

    const base = new Date("2026-01-01T00:00:00.000Z");
    const id1 = "019db000-0000-7000-8000-000000000001";
    const id2 = "019db000-0000-7000-8000-000000000002";
    const id3 = "019db000-0000-7000-8000-000000000003";
    const now = new Date();
    await container.db.insert(schema.todos).values([
      {
        id: id1,
        title: "t-0",
        status: "active",
        version: 0,
        createdAt: base,
        updatedAt: now,
      },
      {
        id: id2,
        title: "t-5",
        status: "active",
        version: 0,
        createdAt: new Date(base.getTime() + 5_000),
        updatedAt: now,
      },
      {
        id: id3,
        title: "t-10",
        status: "active",
        version: 0,
        createdAt: new Date(base.getTime() + 10_000),
        updatedAt: now,
      },
    ]);

    const { todos: result } = await listTodos({
      container,
      input: { page: 1, limit: 20 },
    });

    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe(id3);
    expect(result[1]?.id).toBe(id2);
    expect(result[2]?.id).toBe(id1);
  });

  it("does not produce outbox events (readonly operation)", async () => {
    const container = getContainer();

    await createTodo({ container, input: { title: "seed" } });

    const beforeRows = await container.db.select().from(schema.outboxEvents);
    const beforeCount = beforeRows.length;

    await listTodos({ container, input: { page: 1, limit: 20 } });
    await listTodos({ container, input: { page: 1, limit: 20 } });

    const afterRows = await container.db.select().from(schema.outboxEvents);
    expect(afterRows).toHaveLength(beforeCount);
  });
});
