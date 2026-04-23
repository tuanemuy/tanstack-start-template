import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { setupTestContainer } from "../../__tests__/helpers";
import { createTodo } from "../../todo/createTodo";
import { deleteTodo } from "../../todo/deleteTodo";
import { toggleTodo } from "../../todo/toggleTodo";
import { type EventDispatcher, processOutboxEvents } from "../eventRelayWorker";

describe("processOutboxEvents", () => {
  const getContainer = setupTestContainer();

  it("dispatches and marks as processed for all pending events", async () => {
    const container = getContainer();

    // Seed 3 events via real use cases.
    const { todo: a } = await createTodo({
      container,
      input: { title: "A" },
    });
    await toggleTodo({ container, input: { id: a.id } });
    await deleteTodo({ container, input: { id: a.id } });

    // Sanity: 3 pending entries before processing.
    const beforeRows = await container.db.select().from(schema.outboxEvents);
    expect(beforeRows).toHaveLength(3);
    expect(beforeRows.every((r) => r.processedAt === null)).toBe(true);

    const dispatch: EventDispatcher = vi.fn(async () => {});
    const { processed } = await processOutboxEvents(container, dispatch);

    expect(processed).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);

    // Ensure the dispatcher saw the expected event types in occurredAt order.
    const calls = (dispatch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const types = calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["todo.created", "todo.toggled", "todo.deleted"]);

    // All rows should now be marked processed and no pending entries remain.
    const afterRows = await container.db.select().from(schema.outboxEvents);
    expect(afterRows).toHaveLength(3);
    expect(afterRows.every((r) => r.processedAt !== null)).toBe(true);
    // markProcessed must also clear lease metadata.
    expect(afterRows.every((r) => r.leaseToken === null)).toBe(true);
    expect(afterRows.every((r) => r.leasedUntil === null)).toBe(true);

    const pending = await container.unitOfWorkProvider.run(
      ({ outboxRepository }) => outboxRepository.findPendingEvents(100),
      { mode: "readonly" },
    );
    expect(pending).toHaveLength(0);
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

    // Seed 3 outbox entries directly via the repository.
    const id = TodoId.generate();
    const title = TodoTitle.create("batched");
    await container.unitOfWorkProvider.run(async ({ outboxRepository }) => {
      await outboxRepository.saveEvents([
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

    const pending = await container.unitOfWorkProvider.run(
      ({ outboxRepository }) => outboxRepository.findPendingEvents(100),
      { mode: "readonly" },
    );
    expect(pending).toHaveLength(1);
  });

  it("two concurrent workers claim disjoint events (no double-dispatch)", async () => {
    const container = getContainer();

    // Seed 4 outbox entries.
    const id = TodoId.generate();
    const title = TodoTitle.create("concurrent");
    await container.unitOfWorkProvider.run(async ({ outboxRepository }) => {
      await outboxRepository.saveEvents([
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

    // Pending set is drained.
    const pending = await container.unitOfWorkProvider.run(
      ({ outboxRepository }) => outboxRepository.findPendingEvents(100),
      { mode: "readonly" },
    );
    expect(pending).toHaveLength(0);
  });

  it("re-claims entries whose lease has expired (crashed worker scenario)", async () => {
    const container = getContainer();

    // Seed 1 outbox entry.
    const id = TodoId.generate();
    const title = TodoTitle.create("lease-expiry");
    await container.unitOfWorkProvider.run(async ({ outboxRepository }) => {
      await outboxRepository.saveEvents([TodoEvents.created(id, title)]);
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
});
