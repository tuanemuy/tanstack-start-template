import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { isBusinessRuleError } from "@/core/domain/error";
import { Todo } from "@/core/domain/todo/entity";
import { TodoErrorCode } from "@/core/domain/todo/errorCode";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { setupFakeTestContainer } from "../../__tests__/helpers";
import {
  ConflictErrorCode,
  isConflictError,
  isNotFoundError,
  isValidationError,
  NotFoundErrorCode,
  ValidationErrorCode,
} from "../../errors";
import { changeTodoStatus } from "../changeTodoStatus";
import { createTodo } from "../createTodo";
import { deleteTodo } from "../deleteTodo";
import { listTodos } from "../listTodos";

/**
 * Fast usecase-logic tests backed by in-memory fakes.
 *
 * Scope: validation, usecase orchestration, emitted-event ordering,
 * optimistic-lock simulation at the repository port.
 *
 * Adapter-specific concerns (real transaction rollback, concurrent writers,
 * SQLite retry budgets, etc.) live in `todo.integration.test.ts`.
 */

describe("createTodo (fake)", () => {
  const getContainer = setupFakeTestContainer();

  it("persists the todo and records a todo.created event", async () => {
    const container = getContainer();

    const { todo } = await createTodo({
      container,
      input: { title: "Buy milk" },
    });
    expect(todo.title).toBe("Buy milk");
    expect(todo.completed).toBe(false);

    // Single aggregate in the store, keyed by id.
    const listed = await listTodos({ container, input: undefined });
    expect(listed.todos).toHaveLength(1);
    expect(listed.todos[0]?.id).toBe(todo.id);

    const events = container.fakeUow.getRecordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("todo.created");
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
    // Failed validation must not leak into the event log — the UoW buffers
    // events per-callback and the fake drops them when the callback
    // rejects (same contract as the real adapter's rollback).
    expect(container.fakeUow.getRecordedEvents()).toHaveLength(0);
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

describe("changeTodoStatus (fake)", () => {
  const getContainer = setupFakeTestContainer();

  it("changes status to completed and appends a todo.toggled event", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "Toggle me" },
    });

    const { todo: completed } = await changeTodoStatus({
      container,
      input: { id: created.id, status: "completed" },
    });
    expect(completed.completed).toBe(true);

    const events = container.fakeUow.getRecordedEvents();
    // created + toggled, in emission order.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["todo.created", "todo.toggled"]);
  });

  it("is idempotent when the requested status is already current", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "Already active" },
    });

    const { todo } = await changeTodoStatus({
      container,
      input: { id: created.id, status: "active" },
    });

    expect(todo.completed).toBe(false);
    const events = container.fakeUow.getRecordedEvents();
    expect(events.map((e) => e.type)).toEqual(["todo.created"]);
  });

  it("throws NotFoundError(TodoNotFound) for a valid UUIDv7 that does not exist", async () => {
    const container = getContainer();
    try {
      await changeTodoStatus({
        container,
        input: { id: uuidv7(), status: "completed" },
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
      await changeTodoStatus({
        container,
        input: { id: "not-a-uuid", status: "completed" },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });

  it("surfaces ConflictError(OptimisticLockFailure) when saving a stale aggregate", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "stale" },
    });

    // Snapshot at version 0.
    const staleId = TodoId.create(created.id);
    const stale = await container.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => {
        const current = await todoRepository.findById(staleId);
        if (!current) throw new Error("seed failed");
        return current;
      },
    );

    // Advance the persisted row to version 1.
    await changeTodoStatus({
      container,
      input: { id: created.id, status: "completed" },
    });

    // Now try to save a mutation derived from the stale (version 0) read.
    // The fake's OCC guard fires just like the real adapter would.
    const { entity: staleMutation } = Todo.toggle(stale, container.clock.now());

    let caught: unknown;
    try {
      await container.unitOfWorkProvider.runReadWrite(
        async ({ todoRepository }) => {
          await todoRepository.save(staleMutation);
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
});

describe("deleteTodo (fake)", () => {
  const getContainer = setupFakeTestContainer();

  it("removes the row and appends a todo.deleted event", async () => {
    const container = getContainer();
    const { todo: created } = await createTodo({
      container,
      input: { title: "Delete me" },
    });

    await deleteTodo({ container, input: { id: created.id } });

    const listed = await listTodos({ container, input: undefined });
    expect(listed.todos).toHaveLength(0);

    const types = container.fakeUow.getRecordedEvents().map((e) => e.type);
    expect(types).toEqual(["todo.created", "todo.deleted"]);
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

describe("listTodos (fake)", () => {
  const getContainer = setupFakeTestContainer();

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

    // Seed three todos directly into the fake store with explicit
    // timestamps so the ordering is unambiguous without relying on
    // clock resolution inside `Todo.create`.
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const id1 = TodoId.create("019db000-0000-7000-8000-000000000001");
    const id2 = TodoId.create("019db000-0000-7000-8000-000000000002");
    const id3 = TodoId.create("019db000-0000-7000-8000-000000000003");
    const rows: Todo[] = [
      {
        status: "active",
        id: id1,
        title: TodoTitle.create("t-0"),
        version: 0,
        createdAt: new Date(base),
        updatedAt: new Date(base),
      },
      {
        status: "active",
        id: id2,
        title: TodoTitle.create("t-5"),
        version: 0,
        createdAt: new Date(base + 5_000),
        updatedAt: new Date(base + 5_000),
      },
      {
        status: "active",
        id: id3,
        title: TodoTitle.create("t-10"),
        version: 0,
        createdAt: new Date(base + 10_000),
        updatedAt: new Date(base + 10_000),
      },
    ];
    for (const row of rows) {
      container.fakeUow.todoStore.set(row.id, row);
    }

    const { todos } = await listTodos({
      container,
      input: undefined,
    });

    expect(todos).toHaveLength(3);
    // Descending createdAt → offset 10, 5, 0.
    expect(todos.map((t) => t.id)).toEqual([id3, id2, id1]);
  });

  it("does not produce events (readonly mode)", async () => {
    const container = getContainer();

    await createTodo({
      container,
      input: { title: "only one" },
    });
    const before = container.fakeUow.getRecordedEvents().length;

    await listTodos({ container, input: undefined });
    await listTodos({ container, input: undefined });

    expect(container.fakeUow.getRecordedEvents()).toHaveLength(before);
  });

  it("raises ValidationError(InvalidInput) with fieldErrors on bad pagination", async () => {
    const container = getContainer();
    try {
      await listTodos({
        container,
        input: { page: 0, limit: 20 },
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isValidationError(error)).toBe(true);
      if (isValidationError(error)) {
        expect(error.code).toBe(ValidationErrorCode.InvalidInput);
        // `zodIssuesToFieldErrors` should have populated the `page` path.
        expect(error.fieldErrors).toBeDefined();
        expect(Object.keys(error.fieldErrors ?? {})).toContain("page");
      }
    }
  });
});
