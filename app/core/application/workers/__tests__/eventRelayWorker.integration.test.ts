import { asc, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/core/adapters/d1/schema";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { FakeIdGenerator, FakeLogger } from "../../__tests__/fakes";
import { setupTestContainer } from "../../__tests__/helpers";
import { changeTodoStatus } from "../../todo/changeTodoStatus";
import { createTodo } from "../../todo/createTodo";
import { deleteTodo } from "../../todo/deleteTodo";
import { type EventDispatcher, processOutboxEvents } from "../eventRelayWorker";

const T0 = new Date(0);

// A `FakeIdGenerator` shared across the file feeds deterministic `TodoId`s.
// Outbox event ids are minted by the container's UoW when drafts are
// buffered — tests no longer thread `EventId` through manually.
const ids = new FakeIdGenerator();
const nextTodoId = (): TodoId => TodoId.create(ids.next());

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
        TodoEvents.created(id, title, T0),
        TodoEvents.toggled(id, true, T0),
        TodoEvents.deleted(id, T0),
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
      createdAt: new Date(),
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
      createdAt: new Date(),
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
    // `TodoId.create` is intentionally format-agnostic at the domain
    // layer (UUIDv7 enforcement is on the adapter side). A malformed
    // payload here violates a still-load-bearing invariant: the title
    // must be non-empty.
    await container.db.insert(schema.outboxEvents).values({
      id: badId,
      eventType: "todo.created",
      aggregateId: badId,
      payload: { todoId: badId, title: "" },
      occurredAt: new Date(0),
      createdAt: new Date(0),
    });
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(goodId, goodTitle, T0)]);
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
        TodoEvents.created(idA, title, T0),
        TodoEvents.created(idB, title, T0),
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
      collectEvents([TodoEvents.created(id, title, T0)]);
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
      collectEvents([TodoEvents.created(id, title, T0)]);
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

  it("schedules a backed-off retry after a dispatch failure", async () => {
    const container = getContainer();
    const id = nextTodoId();
    const title = TodoTitle.create("retry-backoff");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(id, title, T0)]);
    });

    const dispatch: EventDispatcher = vi.fn(async () => {
      throw new Error("transient downstream blip");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await processOutboxEvents(container, dispatch, {
      backoffMs: () => 60_000,
    });
    errorSpy.mockRestore();

    const rows = await container.db.select().from(schema.outboxEvents);
    const row = rows[0];
    if (!row) return;
    expect(row.attempts).toBe(1);
    expect(row.processedAt).toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.lastError).toMatch(/transient downstream blip/);
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("excludes rows whose nextAttemptAt is still in the future from claimPending", async () => {
    const container = getContainer();
    const id = nextTodoId();
    const title = TodoTitle.create("not-yet");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(id, title, T0)]);
    });

    const failing: EventDispatcher = vi.fn(async () => {
      throw new Error("first failure");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await processOutboxEvents(container, failing, {
      backoffMs: () => 60_000,
    });

    // Second tick immediately after: row is still cooling off, so the
    // worker should skip it without ever calling dispatch again.
    const followUp: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, followUp, {
      backoffMs: () => 60_000,
    });
    errorSpy.mockRestore();

    expect(processed).toBe(0);
    expect(followUp).not.toHaveBeenCalled();
  });

  it("quarantines a row once it crosses the maxAttempts threshold", async () => {
    const container = getContainer();
    const logger = new FakeLogger();
    const containerWithLogger = { ...container, logger };
    const id = nextTodoId();
    const title = TodoTitle.create("poison");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(id, title, T0)]);
    });

    // Pre-bump the row to one attempt below the cap so a single failing
    // tick is enough to trip the quarantine branch.
    await container.db.update(schema.outboxEvents).set({ attempts: 1 });

    const dispatch: EventDispatcher = vi.fn(async () => {
      throw new Error("still angry");
    });
    await processOutboxEvents(containerWithLogger, dispatch, {
      maxAttempts: 2,
      backoffMs: () => 60_000,
    });

    const rows = await container.db.select().from(schema.outboxEvents);
    const row = rows[0];
    if (!row) return;
    expect(row.attempts).toBe(2);
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.processedAt).toBeNull();

    const errors = logger.byLevel("error");
    expect(errors.some((e) => /quarantining/.test(e.message))).toBe(true);

    // A subsequent tick must NOT re-pick a quarantined row.
    const followUp: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(
      containerWithLogger,
      followUp,
    );
    expect(processed).toBe(0);
    expect(followUp).not.toHaveBeenCalled();
  });

  it("quarantines a poison decoder row after the configured attempts", async () => {
    const container = getContainer();
    const poisonId = "01950000-0000-7000-8000-000000000abc";
    await container.db.insert(schema.outboxEvents).values({
      id: poisonId,
      eventType: "mystery.happened",
      aggregateId: poisonId,
      payload: {},
      occurredAt: new Date(0),
      createdAt: new Date(0),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First tick: bumps attempts to 1, schedules retry.
    await processOutboxEvents(container, dispatch, {
      maxAttempts: 2,
      backoffMs: () => 0,
    });
    // Second tick: bumps to 2 → quarantine.
    await processOutboxEvents(container, dispatch, {
      maxAttempts: 2,
      backoffMs: () => 0,
    });
    errorSpy.mockRestore();

    const rows = await container.db.select().from(schema.outboxEvents);
    const row = rows[0];
    if (!row) return;
    expect(row.attempts).toBe(2);
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.lastError).toMatch(/No decoder registered/);
  });

  it("limits in-flight dispatches to the configured concurrency", async () => {
    const container = getContainer();
    const title = TodoTitle.create("conc");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents(
        Array.from({ length: 10 }, () =>
          TodoEvents.created(nextTodoId(), title, T0),
        ),
      );
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch: EventDispatcher = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    const { processed } = await processOutboxEvents(container, dispatch, {
      concurrency: 3,
    });

    expect(processed).toBe(10);
    expect(dispatch).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(3);
  });
});
