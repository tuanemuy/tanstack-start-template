import { describe, expect, it } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { Todo } from "@/core/domain/todo/entity";
import { TodoId } from "@/core/domain/todo/valueObject";
import { setupTestContainer } from "../../__tests__/helpers";
import {
  ConflictErrorCode,
  isConflictError,
  isNotFoundError,
} from "../../errors";
import { changeTodoStatus } from "../changeTodoStatus";
import { createTodo } from "../createTodo";
import { deleteTodo } from "../deleteTodo";

/**
 * Integration tests that exercise behaviour the in-memory fake cannot model:
 *
 * - Concurrent mutations (real transactions + WAL / busy_timeout).
 * - The `RetryingUnitOfWorkProvider` in combination with the Drizzle adapter.
 * - Post-commit outbox row placement (same transaction as the entity write).
 *
 * Kept in a `*.integration.test.ts` file so the fast usecase suite can be
 * filtered independently via `test:integration` / `test:unit`.
 */

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

describe("concurrent changeTodoStatus", () => {
  const getContainer = setupTestContainer();

  it("two concurrent change-status commands converge on completed=true", async () => {
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

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed).toBe(true);
    expect(rows[0]?.version).toBe(1);
  });

  // The canonical optimistic-lock scenario: a writer that committed based on
  // a stale read. We bypass the usecase and hit `todoRepository.save`
  // directly so we can stage the exact sequence of events — create, status change
  // (advances DB version to 1), then attempt to save a mutated aggregate
  // derived from the stale pre-change (version 0) read.
  it("repository rejects with ConflictError(OptimisticLockFailure) when saving a stale aggregate", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "stale-read" },
    });

    const staleId = TodoId.create(created.id);
    const stale = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => {
        const current = await todoRepository.findById(staleId);
        if (!current) throw new Error("expected todo to exist");
        return current;
      },
    );
    expect(stale.version).toBe(0);

    await changeTodoStatus({
      container,
      input: { id: created.id, status: "completed" },
    });

    // Fixed instant — the mutation is rejected before its `updatedAt` lands
    // anywhere observable, so any value would do; keep it stable for clarity.
    const { entity: staleMutation } = Todo.toggle(
      stale,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    let caught: unknown;
    let resolved = false;
    try {
      await container.unitOfWorkProvider.runReadWrite(
        async ({ todoRepository }) => {
          await todoRepository.save(staleMutation);
        },
      );
      resolved = true;
    } catch (error) {
      caught = error;
    }
    if (resolved) expect.fail("stale save should have thrown");
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.code).toBe(ConflictErrorCode.OptimisticLockFailure);
    }

    const rows = await container.db.select().from(schema.todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed).toBe(true);
    expect(rows[0]?.version).toBe(1);
  });
});
