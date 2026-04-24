import { asc, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { FakeLogger } from "../../__tests__/fakes";
import { setupTestContainer } from "../../__tests__/helpers";
import { createEventDecoderRegistry } from "../../events/eventDispatch";
import { changeTodoStatus } from "../../todo/changeTodoStatus";
import { createTodo } from "../../todo/createTodo";
import { deleteTodo } from "../../todo/deleteTodo";
import { type EventDispatcher, processOutboxEvents } from "../eventRelayWorker";

// Fixed timestamp for any directly-constructed event in tests. The relay
// worker doesn't care about `occurredAt` semantics — it only relays — so
// pinning it here keeps the calls terse and the suite deterministic.
const T0 = new Date(0);

describe("processOutboxEvents", () => {
  const getContainer = setupTestContainer();

  it("dispatches decoded events with branded payloads and marks rows processed", async () => {
    const container = getContainer();

    // Seed 3 events via real use cases.
    const { todo: a } = await createTodo({
      container,
      input: { title: "A" },
    });
    await changeTodoStatus({
      container,
      input: { id: a.id, status: "completed" },
    });
    await deleteTodo({ container, input: { id: a.id } });

    // Sanity: 3 pending entries before processing.
    const beforeRows = await container.db
      .select()
      .from(schema.outboxEvents)
      .orderBy(asc(schema.outboxEvents.sequence));
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

    // Decoder ran before dispatch: the payload's `todoId` was reconstructed
    // via `TodoId.create`, so it must equal the original branded id exactly.
    // (Brands are erased at runtime, but value equality + factory-validated
    // shape is the observable guarantee.)
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
    expect(afterRows).toHaveLength(3);
    expect(afterRows.every((r) => r.processedAt !== null)).toBe(true);
    expect(afterRows.every((r) => r.leaseToken === null)).toBe(true);
    expect(afterRows.every((r) => r.leasedUntil === null)).toBe(true);
    const stillPending = await container.db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(stillPending).toHaveLength(0);
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

    // Seed 3 outbox entries through the normal event path (`collectEvents`
    // flushes into the outbox on commit) — usecases no longer have direct
    // access to `outboxRepository.saveEvents`.
    const id = TodoId.generate();
    const title = TodoTitle.create("batched");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([
          TodoEvents.created(id, title, T0),
          TodoEvents.toggled(id, true, T0),
          TodoEvents.deleted(id, T0),
        ]);
      },
    );

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

  it("two concurrent workers claim disjoint events (no double-dispatch)", async () => {
    const container = getContainer();

    // Seed 4 outbox entries via the normal event path.
    const id = TodoId.generate();
    const title = TodoTitle.create("concurrent");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([
          TodoEvents.created(id, title, T0),
          TodoEvents.toggled(id, true, T0),
          TodoEvents.toggled(id, false, T0),
          TodoEvents.deleted(id, T0),
        ]);
      },
    );

    const dispatchA: EventDispatcher = vi.fn(async () => {});
    const dispatchB: EventDispatcher = vi.fn(async () => {});

    const [resA, resB] = await Promise.all([
      processOutboxEvents(container, dispatchA, { batchSize: 4 }),
      processOutboxEvents(container, dispatchB, { batchSize: 4 }),
    ]);

    // Each event must have been dispatched exactly once in aggregate.
    const total = resA.processed + resB.processed;
    expect(total).toBe(4);
    expect(
      (dispatchA as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .length +
        (dispatchB as unknown as { mock: { calls: unknown[][] } }).mock.calls
          .length,
    ).toBe(4);

    // And no event id appears in both dispatcher's calls.
    const idsA = (
      dispatchA as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => (c[0] as { id: string }).id);
    const idsB = (
      dispatchB as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => (c[0] as { id: string }).id);
    const intersection = idsA.filter((x) => idsB.includes(x));
    expect(intersection).toEqual([]);

    const pending = await container.db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(pending).toHaveLength(0);
  });

  it("re-claims entries whose lease has expired (crashed worker scenario)", async () => {
    const container = getContainer();

    // Seed 1 outbox entry via the normal event path.
    const id = TodoId.generate();
    const title = TodoTitle.create("lease-expiry");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(id, title, T0)]);
      },
    );

    const rowsBefore = await container.db.select().from(schema.outboxEvents);
    expect(rowsBefore).toHaveLength(1);
    const seededId = rowsBefore[0]?.id;
    expect(seededId).toBeDefined();
    if (!seededId) return;

    // Simulate a previous worker that claimed the row but crashed before
    // calling markProcessed: stamp a lease that is already in the past.
    const pastLease = new Date(Date.now() - 60_000);
    await container.db
      .update(schema.outboxEvents)
      .set({ leaseToken: "stale-token", leasedUntil: pastLease })
      .where(eq(schema.outboxEvents.id, seededId));

    // A fresh worker should re-claim the expired row and dispatch it.
    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    expect(processed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const rowsAfter = await container.db.select().from(schema.outboxEvents);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.processedAt).not.toBeNull();
    expect(rowsAfter[0]?.leaseToken).toBeNull();
    expect(rowsAfter[0]?.leasedUntil).toBeNull();
  });

  it("skips events whose prefix has no registered decoder (logs, keeps batch moving)", async () => {
    const container = getContainer();

    // Insert a row whose `event_type` is in an unknown domain.
    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000001",
      eventType: "mystery.happened",
      schemaVersion: 1,
      payload: {
        payload: {},
        aggregateId: "01950000-0000-7000-8000-000000000001",
      },
      occurredAt: new Date(),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    // The row must still be pending (unprocessed) — the failed decode left
    // the lease stamped but didn't mark it processed. Pending-in-the-broad-
    // sense: processedAt is still null.
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("emits a structured error log via the injected Logger on decode failure", async () => {
    const container = getContainer();

    // Swap the container's logger for a FakeLogger so we can assert on
    // decode-failure observability without spying on `console`. This is
    // exactly the "wire a different logger for tests" affordance the port
    // was introduced for.
    const logger = new FakeLogger();
    const containerWithLogger = { ...container, logger };

    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000099",
      eventType: "mystery.happened",
      schemaVersion: 1,
      payload: {
        payload: {},
        aggregateId: "01950000-0000-7000-8000-000000000099",
      },
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
    // Structured meta keys are part of the contract — operators rely on
    // them for filtering / alerting.
    expect(errors[0]?.meta?.eventId).toBe(
      "01950000-0000-7000-8000-000000000099",
    );
    expect(errors[0]?.meta?.eventType).toBe("mystery.happened");
    expect(errors[0]?.meta?.cause).toBeDefined();
  });

  it("skips malformed payloads rather than aborting the batch", async () => {
    const container = getContainer();

    // Insert one malformed row (invalid todoId) and one valid row. The
    // worker must skip the bad row and dispatch the good one — a single
    // decode failure cannot block delivery of the rest of the batch.
    const badId = "01950000-0000-7000-8000-000000000002";
    const goodId = TodoId.generate();
    const goodTitle = TodoTitle.create("ok");
    await container.db.insert(schema.outboxEvents).values({
      id: badId,
      eventType: "todo.created",
      schemaVersion: 1,
      payload: {
        payload: { todoId: "not-a-uuid", title: "ok" },
        aggregateId: badId,
      },
      occurredAt: new Date(0),
    });
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(goodId, goodTitle, T0)]);
      },
    );

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const rows = await container.db
      .select()
      .from(schema.outboxEvents)
      .orderBy(asc(schema.outboxEvents.sequence));
    // The bad row remains pending (lease will expire, retry later).
    expect(rows[0]?.id).toBe(badId);
    expect(rows[0]?.processedAt).toBeNull();
    // The good row was dispatched and marked processed.
    expect(rows[1]?.processedAt).not.toBeNull();
  });

  it("tolerates dispatcher failure on one row without dropping the rest of the batch", async () => {
    const container = getContainer();

    const idA = TodoId.generate();
    const idB = TodoId.generate();
    const title = TodoTitle.create("allSettled");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([
          TodoEvents.created(idA, title, T0),
          TodoEvents.created(idB, title, T0),
        ]);
      },
    );

    // First dispatch call fails, second succeeds. `Promise.allSettled`
    // keeps the batch alive: only the successful row is marked processed.
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

    // Exactly one row is marked processed; the other stays pending for
    // lease-expiry-driven retry.
    const rows = await container.db.select().from(schema.outboxEvents);
    const processedRows = rows.filter((r) => r.processedAt !== null);
    const pendingRows = rows.filter((r) => r.processedAt === null);
    expect(processedRows).toHaveLength(1);
    expect(pendingRows).toHaveLength(1);
  });

  it("tolerates multiple simultaneous dispatcher failures mixed with successes", async () => {
    const container = getContainer();

    // Seed 5 events; dispatcher fails on ids in positions 0 and 3 (by
    // call order). The remaining three must still be marked processed.
    const ids = [
      TodoId.generate(),
      TodoId.generate(),
      TodoId.generate(),
      TodoId.generate(),
      TodoId.generate(),
    ];
    const title = TodoTitle.create("mixed");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents(ids.map((id) => TodoEvents.created(id, title, T0)));
      },
    );

    let call = 0;
    const failingCalls = new Set([1, 4]); // 1st and 4th dispatch call fail.
    const dispatch: EventDispatcher = vi.fn(async () => {
      call += 1;
      if (failingCalls.has(call)) throw new Error(`consumer rejected #${call}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    // 5 attempted, 2 failed, 3 marked.
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(processed).toBe(3);

    const rows = await container.db.select().from(schema.outboxEvents);
    const processedRows = rows.filter((r) => r.processedAt !== null);
    const pendingRows = rows.filter((r) => r.processedAt === null);
    expect(processedRows).toHaveLength(3);
    // The two pending rows stay available for a future lease-expiry retry.
    expect(pendingRows).toHaveLength(2);
  });

  it("does not call markProcessed when every dispatch fails (no wasted round-trip)", async () => {
    const container = getContainer();

    const id = TodoId.generate();
    const title = TodoTitle.create("all-fail");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(id, title, T0)]);
      },
    );

    const dispatch: EventDispatcher = vi.fn(async () => {
      throw new Error("consumer is always angry");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch);
    errorSpy.mockRestore();

    expect(processed).toBe(0);

    // Row stays pending. No row was marked — the lease is still live
    // so it's not re-claimable immediately, but processedAt remains null.
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("accepts a caller-supplied decoder registry (composable, testable)", async () => {
    const container = getContainer();

    const id = TodoId.generate();
    const title = TodoTitle.create("custom-registry");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(id, title, T0)]);
      },
    );

    // Registry without `todo` entry -> decode failure reported via the
    // Result channel, worker skips the row, returns 0 processed.
    const emptyRegistry = createEventDecoderRegistry({});
    const dispatch: EventDispatcher = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { processed } = await processOutboxEvents(container, dispatch, {
      decoderRegistry: emptyRegistry,
    });
    errorSpy.mockRestore();
    expect(processed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
