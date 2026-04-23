import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { isBusinessRuleError } from "@/core/domain/error";
import { Todo } from "@/core/domain/todo/entity";
import { TodoErrorCode } from "@/core/domain/todo/errorCode";
import { TodoId } from "@/core/domain/todo/valueObject";
import { setupTestContainer } from "../../__tests__/helpers";
import {
  ConflictErrorCode,
  isConflictError,
  isNotFoundError,
  NotFoundErrorCode,
} from "../../error";
import { createTodo } from "../createTodo";
import { deleteTodo } from "../deleteTodo";
import { listTodos } from "../listTodos";
import { toggleTodo } from "../toggleTodo";

describe("createTodo", () => {
  const getContainer = setupTestContainer();

  it("persists the todo and records a todo.created outbox event", async () => {
    const container = getContainer();

    const { todo } = await createTodo({
      container,
      input: { title: "Buy milk" },
    });
    expect(todo.title).toBe("Buy milk");
    expect(todo.completed).toBe(false);

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(todo.id);

    const outbox = await container.db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe("todo.created");
    expect(outbox[0]?.processedAt).toBeNull();
  });

  it("rejects an empty title with BusinessRuleError(TitleEmpty)", async () => {
    const container = getContainer();
    try {
      await createTodo({ container, input: { title: "   " } });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleEmpty);
      }
    }
  });

  it("rejects a 141-character title with BusinessRuleError(TitleTooLong)", async () => {
    const container = getContainer();
    try {
      await createTodo({
        container,
        input: { title: "a".repeat(141) },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleTooLong);
      }
    }
  });

  it("accepts a 140-character title", async () => {
    const container = getContainer();
    const title = "a".repeat(140);
    const { todo } = await createTodo({
      container,
      input: { title },
    });
    expect(todo.title).toBe(title);
    expect(todo.title.length).toBe(140);
  });
});

describe("toggleTodo", () => {
  const getContainer = setupTestContainer();

  it("flips completion and appends a todo.toggled outbox event", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "Toggle me" },
    });

    const { todo: toggled } = await toggleTodo({
      container,
      input: { id: created.id },
    });
    expect(toggled.completed).toBe(true);

    const outbox = await container.db.select().from(schema.outboxEvents);
    // created + toggled
    expect(outbox).toHaveLength(2);
    const types = outbox.map((r) => r.eventType);
    expect(types).toContain("todo.created");
    expect(types).toContain("todo.toggled");
  });

  it("throws NotFoundError(TodoNotFound) for a valid UUIDv7 that does not exist", async () => {
    const container = getContainer();
    try {
      await toggleTodo({
        container,
        input: { id: uuidv7() },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isNotFoundError(error)).toBe(true);
      if (isNotFoundError(error)) {
        expect(error.code).toBe(NotFoundErrorCode.TodoNotFound);
      }
    }
  });

  it("throws BusinessRuleError(InvalidId) for a malformed id", async () => {
    const container = getContainer();
    try {
      await toggleTodo({
        container,
        input: { id: "not-a-uuid" },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });
});

describe("deleteTodo", () => {
  const getContainer = setupTestContainer();

  it("removes the row and appends a todo.deleted outbox event", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "Delete me" },
    });

    await deleteTodo({ container, input: { id: created.id } });

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);

    const outbox = await container.db.select().from(schema.outboxEvents);
    const types = outbox.map((r) => r.eventType);
    expect(types).toContain("todo.created");
    expect(types).toContain("todo.deleted");
  });

  it("throws NotFoundError(TodoNotFound) when deleting a non-existent id", async () => {
    const container = getContainer();
    try {
      await deleteTodo({
        container,
        input: { id: uuidv7() },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isNotFoundError(error)).toBe(true);
      if (isNotFoundError(error)) {
        expect(error.code).toBe(NotFoundErrorCode.TodoNotFound);
      }
    }
  });

  it("throws BusinessRuleError(InvalidId) for a malformed id", async () => {
    const container = getContainer();
    try {
      await deleteTodo({
        container,
        input: { id: "not-a-uuid" },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });
});

describe("listTodos", () => {
  const getContainer = setupTestContainer();

  it("returns an empty list when no todos exist", async () => {
    const container = getContainer();
    const { todos } = await listTodos({
      container,
      input: undefined,
    });
    expect(todos).toEqual([]);
  });

  it("returns todos ordered by createdAt descending", async () => {
    const container = getContainer();

    // SQLite timestamp mode stores seconds, so sub-second inserts would be
    // non-deterministic for ORDER BY. Seed rows directly with spaced-apart
    // timestamps so the ordering is unambiguous.
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const rows = [
      { id: "019db000-0000-7000-8000-000000000001", offsetSec: 0 },
      { id: "019db000-0000-7000-8000-000000000002", offsetSec: 5 },
      { id: "019db000-0000-7000-8000-000000000003", offsetSec: 10 },
    ];

    for (const row of rows) {
      const when = new Date(base + row.offsetSec * 1000);
      await container.db.insert(schema.todos).values({
        id: row.id,
        title: `t-${row.offsetSec}`,
        completed: false,
        createdAt: when,
        updatedAt: when,
      });
    }

    const { todos } = await listTodos({
      container,
      input: undefined,
    });

    expect(todos).toHaveLength(3);
    // Descending createdAt → offset 10, 5, 0.
    expect(todos.map((t) => t.id)).toEqual([
      rows[2]?.id,
      rows[1]?.id,
      rows[0]?.id,
    ]);
  });

  it("does not produce outbox events (readonly mode)", async () => {
    const container = getContainer();

    await createTodo({
      container,
      input: { title: "only one" },
    });

    const outboxBefore = await container.db.select().from(schema.outboxEvents);
    expect(outboxBefore).toHaveLength(1); // from createTodo

    await listTodos({ container, input: undefined });
    await listTodos({ container, input: undefined });

    const outboxAfter = await container.db.select().from(schema.outboxEvents);
    // listTodos must not write outbox entries.
    expect(outboxAfter).toHaveLength(1);
  });
});

describe("concurrent deleteTodo", () => {
  const getContainer = setupTestContainer();

  it("only one concurrent delete succeeds; the other rejects with NotFoundError", async () => {
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
      expect(isNotFoundError(rejection.reason)).toBe(true);
    }

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(0);
  });
});

describe("concurrent toggleTodo", () => {
  const getContainer = setupTestContainer();

  // Under libsql's `BEGIN IMMEDIATE` transactions, two `toggleTodo` calls in
  // parallel serialize: each reads the latest committed version inside its
  // own transaction, so neither trips the optimistic lock. Both succeed and
  // the aggregate ends up toggled twice (back to its original state) with
  // version advanced by two. That is the correct behavior: the optimistic
  // lock exists to catch stale-read writers, not to serialize transactional
  // readers that each observe committed state.
  it("both sequential toggles succeed; aggregate ends with completed=false and version=2", async () => {
    const container = getContainer();
    const { todo } = await createTodo({
      container,
      input: { title: "race-toggle" },
    });

    const results = await Promise.allSettled([
      toggleTodo({ container, input: { id: todo.id } }),
      toggleTodo({ container, input: { id: todo.id } }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    // Double-toggle returns to the original `completed=false` state.
    expect(rows[0]?.completed).toBe(false);
    // Version advanced exactly twice (once per successful save).
    expect(rows[0]?.version).toBe(2);
  });

  // This is what optimistic locking actually guards against: a writer that
  // committed a mutation based on a stale read. We bypass the usecase and
  // hit `todoRepository.save` directly so we can stage the exact sequence
  // of events — create, toggle (advances DB version to 1), then attempt to
  // save a mutated aggregate derived from the pre-toggle (version 0) read.
  it("toggleTodo rejects with ConflictError(OptimisticLockFailure) when saving a stale aggregate", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "stale-read" },
    });

    // Snapshot the aggregate as a client would have read it before any
    // concurrent mutation. `stale` has version 0.
    const staleId = TodoId.create(created.id);
    const stale = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => {
        const current = await todoRepository.findById(staleId);
        if (!current) throw new Error("expected todo to exist");
        return current;
      },
      { mode: "readonly" },
    );
    expect(stale.version).toBe(0);

    // Another request commits a toggle, moving the persisted row to
    // version 1.
    await toggleTodo({ container, input: { id: created.id } });

    // Now the stale client attempts to persist its own mutation derived
    // from the version-0 read. The produced aggregate has version 1, but
    // the DB row is also at version 1 — so the guarded UPDATE
    // (`WHERE version = 0`) matches zero rows and optimistic locking fires.
    const { entity: staleMutation } = Todo.toggle(stale);

    let caught: unknown;
    let resolved = false;
    try {
      await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
        await todoRepository.save(staleMutation);
      });
      resolved = true;
    } catch (error) {
      caught = error;
    }
    if (resolved) expect.fail("stale save should have thrown");
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe(ConflictErrorCode.OptimisticLockFailure);
    }

    // Sanity: the persisted row still reflects the winning toggle, not
    // the stale writer.
    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed).toBe(true);
    expect(rows[0]?.version).toBe(1);
  });
});
