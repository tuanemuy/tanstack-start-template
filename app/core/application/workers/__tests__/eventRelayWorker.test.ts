import { asc, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { FakeIdGenerator, FakeLogger } from "../../__tests__/fakes";
import { setupTestContainer } from "../../__tests__/helpers";
import { changeTodoStatus } from "../../todo/changeTodoStatus";
import { createTodo } from "../../todo/createTodo";
import { deleteTodo } from "../../todo/deleteTodo";
import { type EventDispatcher, processOutboxEvents } from "../eventRelayWorker";

const T0 = new Date(0);

// A `FakeIdGenerator` shared across the file feeds deterministic ids to the
// usecase + manual `TodoEvents.*` calls below — keeps assertions focused on
// outbox behaviour rather than UUID minting.
const ids = new FakeIdGenerator();
const nextId = (): string => ids.next();
const nextTodoId = (): TodoId => TodoId.create(nextId());

describe("processOutboxEvents", () => {
  const getContainer = setupTestContainer();

  it("dispatches decoded events with branded payloads and marks rows processed", async () => {
    const container = getContainer();

    const { todo: a } = await createTodo({
      container,
      input: { title: "A" },
    });
    await changeTodoStatus({
      container,
      input: { id: a.id, status: "completed" },
    });
    await deleteTodo({ container, input: { id: a.id } });

    const beforeRows = await container.db
      .select()
      .from(schema.outboxEvents)
      .orderBy(asc(schema.outboxEvents.createdAt));
    expect(beforeRows).toHaveLength(3);
    expect(beforeRows.every((r) => r.processedAt === null)).toBe(true);

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, dispatch);

    expect(processed).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);

    const calls = (dispatch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const events = calls.map((c) => c[0] as { type: string; payload: unknown });
    expect(events.map((e) => e.type)).toEqual([
      "todo.created",
      "todo.toggled",
      "todo.deleted",
    ]);

    const created = events[0]?.payload as { todoId: string; title: string };
    expect(created.todoId).toBe(a.id);
    expect(created.title).toBe("A");
    const toggled = events[1]?.payload as {
      todoId: string;
      completed: boolean;
    };
    expect(toggled.todoId).toBe(a.id);
    expect(toggled.completed).toBe(true);
    const deleted = events[2]?.payload as { todoId: string };
    expect(deleted.todoId).toBe(a.id);

    const afterRows = await container.db.select().from(schema.outboxEvents);
    expect(afterRows.every((r) => r.processedAt !== null)).toBe(true);
  });

  it("returns 0 and does not call the dispatcher when there is nothing to do", async () => {
    const container = getContainer();
    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("respects the batchSize option", async () => {
    const container = getContainer();
    const id = nextTodoId();
    const title = TodoTitle.create("batched");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([
        TodoEvents.created(nextId(), id, title, T0),
        TodoEvents.toggled(nextId(), id, true, T0),
        TodoEvents.deleted(nextId(), id, T0),
      ]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, dispatch, {
      batchSize: 2,
    });

    expect(processed).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const pending = await container.db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(pending).toHaveLength(1);
  });

  it("skips events whose type has no registered decoder, keeps batch moving", async () => {
    const container = getContainer();

    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000001",
      eventType: "mystery.happened",
      aggregateId: "01950000-0000-7000-8000-000000000001",
      payload: {},
      occurredAt: new Date(),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("emits a structured error log via the injected Logger on decode failure", async () => {
    const container = getContainer();
    const logger = new FakeLogger();
    const containerWithLogger = { ...container, logger };

    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000099",
      eventType: "mystery.happened",
      aggregateId: "01950000-0000-7000-8000-000000000099",
      payload: {},
      occurredAt: new Date(),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(
      containerWithLogger,
      dispatch,
    );

    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    const errors = logger.byLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/decode failed/);
    expect(errors[0]?.meta?.eventId).toBe(
      "01950000-0000-7000-8000-000000000099",
    );
    expect(errors[0]?.meta?.eventType).toBe("mystery.happened");
    expect(errors[0]?.meta?.cause).toBeDefined();
  });

  it("skips malformed payloads rather than aborting the batch", async () => {
    const container = getContainer();

    const badId = "01950000-0000-7000-8000-000000000002";
    const goodId = nextTodoId();
    const goodTitle = TodoTitle.create("ok");
    await container.db.insert(schema.outboxEvents).values({
      id: badId,
      eventType: "todo.created",
      aggregateId: badId,
      payload: { todoId: "not-a-uuid", title: "ok" },
      occurredAt: new Date(0),
    });
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(nextId(), goodId, goodTitle, T0)]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const rows = await container.db
      .select()
      .from(schema.outboxEvents)
      .orderBy(asc(schema.outboxEvents.createdAt));
    expect(rows[0]?.id).toBe(badId);
    expect(rows[0]?.processedAt).toBeNull();
    expect(rows[1]?.processedAt).not.toBeNull();
  });

  it("tolerates dispatcher failure on one row without dropping the rest of the batch", async () => {
    const container = getContainer();

    const idA = nextTodoId();
    const idB = nextTodoId();
    const title = TodoTitle.create("allSettled");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([
        TodoEvents.created(nextId(), idA, title, T0),
        TodoEvents.created(nextId(), idB, title, T0),
      ]);
    });

    let call = 0;
    const dispatch: EventDispatcher = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("consumer is angry");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(processed).toBe(1);

    const rows = await container.db.select().from(schema.outboxEvents);
    const processedRows = rows.filter((r) => r.processedAt !== null);
    const pendingRows = rows.filter((r) => r.processedAt === null);
    expect(processedRows).toHaveLength(1);
    expect(pendingRows).toHaveLength(1);
  });

  it("does not call markProcessed when every dispatch fails", async () => {
    const container = getContainer();

    const id = nextTodoId();
    const title = TodoTitle.create("all-fail");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(nextId(), id, title, T0)]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {
      throw new Error("consumer is always angry");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(0);

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("accepts a caller-supplied decoder registry", async () => {
    const container = getContainer();

    const id = nextTodoId();
    const title = TodoTitle.create("custom-registry");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(nextId(), id, title, T0)]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch, {
      decoderRegistry: {},
    });
    errorSpy.mockRestore();
    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("matches by full event type, not by domain prefix", async () => {
    // Lookup is keyed on the full `event.type` (e.g. `todo.created`), not on
    // the `"todo"` prefix. A registry that only holds the prefix should NOT
    // match an event whose type starts with that prefix.
    const container = getContainer();

    const id = nextTodoId();
    const title = TodoTitle.create("prefix-not-match");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(nextId(), id, title, T0)]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch, {
      // A bare `"todo"` key would have matched under the old prefix-based
      // lookup; under the full-event-type registry it does not.
      decoderRegistry: { todo: () => ({}) as never },
    });
    errorSpy.mockRestore();

    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.processedAt).toBeNull();
  });
});
