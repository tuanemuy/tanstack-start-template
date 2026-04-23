import { asc, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { setupTestContainer } from "../../__tests__/helpers";
import { SystemError, SystemErrorCode } from "../../error";
import { createEventDecoderRegistry } from "../../eventDispatch";
import { createTodo } from "../../todo/createTodo";
import { deleteTodo } from "../../todo/deleteTodo";
import { toggleTodo } from "../../todo/toggleTodo";
import { type EventDispatcher, processOutboxEvents } from "../eventRelayWorker";

describe("processOutboxEvents", () => {
  const getContainer = setupTestContainer();

  it("dispatches decoded events with branded payloads and marks rows processed", async () => {
    const container = getContainer();

    // Seed 3 events via real use cases.
    const { todo: a } = await createTodo({
      container,
      input: { title: "A" },
    });
    await toggleTodo({ container, input: { id: a.id } });
    await deleteTodo({ container, input: { id: a.id } });

    // Sanity: 3 pending entries before processing.
    const beforeRows = await container.db
      .select()
      .from(schema.outboxEvents)
      .orderBy(asc(schema.outboxEvents.occurredAt));
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
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([
        TodoEvents.created(id, title),
        TodoEvents.toggled(id, true),
        TodoEvents.deleted(id),
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

  it("two concurrent workers claim disjoint events (no double-dispatch)", async () => {
    const container = getContainer();

    // Seed 4 outbox entries via the normal event path.
    const id = TodoId.generate();
    const title = TodoTitle.create("concurrent");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([
        TodoEvents.created(id, title),
        TodoEvents.toggled(id, true),
        TodoEvents.toggled(id, false),
        TodoEvents.deleted(id),
      ]);
    });

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
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(id, title)]);
    });

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

  it("rejects events whose prefix has no registered decoder", async () => {
    const container = getContainer();

    // Insert a row whose `event_type` is in an unknown domain.
    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000001",
      eventType: "mystery.happened",
      schemaVersion: 1,
      payload: { payload: {} },
      occurredAt: new Date(),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    await expect(
      processOutboxEvents(container, dispatch),
    ).rejects.toBeInstanceOf(SystemError);

    expect(dispatch).not.toHaveBeenCalled();

    // The row must still be pending (unprocessed) — the failed decode left
    // the lease stamped but didn't mark it processed. Pending-in-the-broad-
    // sense: processedAt is still null.
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("surfaces a malformed payload as an error rather than silent passthrough", async () => {
    const container = getContainer();

    // Insert a todo event with an invalid `todoId` (not a UUIDv7). The
    // decoder must re-run `TodoId.create` and throw before dispatch.
    await container.db.insert(schema.outboxEvents).values({
      id: "01950000-0000-7000-8000-000000000002",
      eventType: "todo.created",
      schemaVersion: 1,
      payload: { payload: { todoId: "not-a-uuid", title: "ok" } },
      occurredAt: new Date(),
    });

    const dispatch: EventDispatcher = vi.fn(async () => {});
    await expect(
      processOutboxEvents(container, dispatch),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accepts a caller-supplied decoder registry (composable, testable)", async () => {
    const container = getContainer();

    const id = TodoId.generate();
    const title = TodoTitle.create("custom-registry");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(id, title)]);
    });

    // Registry without `todo` entry -> strict rejection on decode.
    const emptyRegistry = createEventDecoderRegistry({});
    const dispatch: EventDispatcher = vi.fn(async () => {});
    const err = await processOutboxEvents(container, dispatch, {
      decoderRegistry: emptyRegistry,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SystemError);
    expect((err as SystemError).code).toBe(SystemErrorCode.InternalServerError);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
