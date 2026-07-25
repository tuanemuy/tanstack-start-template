import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@repo/core/domain/common/event";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId, TodoTitle } from "@repo/core/domain/todo/valueObject";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PendingBatch } from "../pendingBatch";
import { D1OutboxRepository } from "../repositories/outboxRepository";
import * as schema from "../schema";
import { createTestContainer } from "./helpers";

/**
 * Integration tests for the D1 outbox repository.
 *
 * The relay-side methods (`claimPending`, `finalize`, `pruneProcessed`)
 * execute as their own atomic statements (or batches), so they are
 * tested directly against `container.outboxRepository`.
 *
 * `save` is buffered and only legal inside a UoW. To keep these tests
 * focused on outbox semantics rather than UoW plumbing, the helper
 * below builds a one-off `PendingBatch`, calls `save`, and flushes —
 * giving the test full control over event ids and timestamps the way
 * giving the test full control over event ids and timestamps.
 */

let counter = 0;
const nextEventId = (): EventId => {
  counter += 1;
  return EventId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-200000000000`,
  );
};
const nextTodoId = () => {
  counter += 1;
  return TodoId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-300000000000`,
  );
};
const withId = <TEvent extends DomainEvent>(
  draft: EventDraft<TEvent>,
): TEvent => ({ ...draft, id: nextEventId() }) as TEvent;

async function manualSave(
  container: ReturnType<typeof createTestContainer>,
  events: readonly DomainEvent[],
  now: Date,
): Promise<void> {
  const pending = new PendingBatch(container.db);
  const repo = new D1OutboxRepository(
    container.db,
    container.idGenerator,
    { now: () => now },
    pending,
  );
  await repo.save(events);
  if (!pending.isEmpty()) {
    await container.db.batch(pending.build());
  }
}

describe("D1OutboxRepository.save (integration)", () => {
  it("writes payload / eventType / aggregateId to the correct columns", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("persistence");
    const event = withId(TodoEvents.created(todoId, title, new Date()));

    await manualSave(container, [event], new Date());

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) return;
    expect(row.id).toBe(event.id);
    expect(row.eventType).toBe("todo.created");
    expect(row.aggregateId).toBe(todoId);
    expect(row.processedAt).toBeNull();

    const stored = row.payload as { todoId: string; title: string };
    expect(stored.todoId).toBe(todoId);
    expect(stored.title).toBe(title);
  });
});

describe("D1OutboxRepository.claimPending (integration)", () => {
  // Miniflare serializes writes; "concurrent" cases below verify SQL
  // correctness, not race resolution (prod relies on SQLite's
  // single-statement write-lock).
  const claimArgs = (now: Date, limit = 10) => ({
    limit,
    now,
    workerId: "worker-test",
    leaseMs: 60_000,
  });

  it("returns only unprocessed entries in approximate created_at order", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("claim");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    await manualSave(container, [a, b], new Date(0));
    await manualSave(container, [], new Date(1000)); // ordering noop

    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.outboxEvents.id, a.id));

    const pending = await container.outboxRepository.claimPending(
      claimArgs(new Date()),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(b.id);
  });

  it("never returns the same row to two concurrent claimers", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const events = Array.from({ length: 8 }, (_, i) =>
      withId(TodoEvents.toggled(todoId, i % 2 === 0, new Date(i))),
    );
    await manualSave(container, events, new Date(0));

    const now = new Date(10_000);
    const [first, second] = await Promise.all([
      container.outboxRepository.claimPending({
        ...claimArgs(now),
        workerId: "worker-A",
      }),
      container.outboxRepository.claimPending({
        ...claimArgs(now),
        workerId: "worker-B",
      }),
    ]);

    const ids = [...first.map((e) => e.id), ...second.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(events.length);
  });

  it("hides newly-claimed rows from concurrent claims until the lease lapses", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("lease");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await manualSave(container, [a], new Date(0));

    const t0 = new Date(10_000);
    const first = await container.outboxRepository.claimPending(claimArgs(t0));
    expect(first).toHaveLength(1);

    // Concurrent claim well within the lease window — must see nothing.
    const t1 = new Date(t0.getTime() + 30_000);
    const second = await container.outboxRepository.claimPending(claimArgs(t1));
    expect(second).toHaveLength(0);

    // Past the lease — re-claim is allowed.
    const t2 = new Date(t0.getTime() + 120_000);
    const third = await container.outboxRepository.claimPending(claimArgs(t2));
    expect(third).toHaveLength(1);
  });
});

describe("D1OutboxRepository.finalize (integration)", () => {
  it("stamps processed_at and clears the claim for processed ids", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("processed");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    await manualSave(container, [a], new Date());

    const claim = new Date(10_000);
    await container.outboxRepository.claimPending({
      limit: 10,
      now: claim,
      workerId: "w1",
      leaseMs: 60_000,
    });

    const processedAt = new Date(20_000);
    await container.outboxRepository.finalize({
      processed: [a.id],
      failures: [],
      now: processedAt,
    });

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.processedAt?.getTime()).toBe(processedAt.getTime());
    expect(rows[0]?.claimedAt).toBeNull();
    expect(rows[0]?.claimedBy).toBeNull();
  });

  it("schedules retry and releases claim when nextAttemptAt is set", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("retry");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    await manualSave(container, [a], new Date());

    await container.outboxRepository.claimPending({
      limit: 10,
      now: new Date(10_000),
      workerId: "w1",
      leaseMs: 60_000,
    });

    const retryAt = new Date(60_000);
    await container.outboxRepository.finalize({
      processed: [],
      failures: [{ id: a.id, error: "transient", nextAttemptAt: retryAt }],
      now: new Date(20_000),
    });

    const row = (await container.db.select().from(schema.outboxEvents))[0];
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("transient");
    expect(row?.nextAttemptAt?.getTime()).toBe(retryAt.getTime());
    expect(row?.failedAt).toBeNull();
    expect(row?.claimedAt).toBeNull();
  });

  it("quarantines the row when nextAttemptAt is null", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("quarantine");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    await manualSave(container, [a], new Date());

    const failedAt = new Date(30_000);
    await container.outboxRepository.finalize({
      processed: [],
      failures: [{ id: a.id, error: "poison", nextAttemptAt: null }],
      now: failedAt,
    });

    const row = (await container.db.select().from(schema.outboxEvents))[0];
    expect(row?.failedAt?.getTime()).toBe(failedAt.getTime());
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("poison");
  });

  it("excludes quarantined rows from claimPending", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("excluded");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    await manualSave(container, [a], new Date());

    await container.outboxRepository.finalize({
      processed: [],
      failures: [{ id: a.id, error: "poison", nextAttemptAt: null }],
      now: new Date(),
    });

    const claimed = await container.outboxRepository.claimPending({
      limit: 10,
      now: new Date(),
      workerId: "w1",
      leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(0);
  });

  it("commits processed and failures together in one call", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("mixed");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    await manualSave(container, [a, b], new Date(0));

    await container.outboxRepository.claimPending({
      limit: 10,
      now: new Date(10_000),
      workerId: "w1",
      leaseMs: 60_000,
    });

    const retryAt = new Date(60_000);
    const finalizeAt = new Date(20_000);
    await container.outboxRepository.finalize({
      processed: [a.id],
      failures: [{ id: b.id, error: "transient", nextAttemptAt: retryAt }],
      now: finalizeAt,
    });

    const rows = await container.db.select().from(schema.outboxEvents);
    const rowA = rows.find((r) => r.id === a.id);
    const rowB = rows.find((r) => r.id === b.id);
    expect(rowA?.processedAt?.getTime()).toBe(finalizeAt.getTime());
    expect(rowA?.claimedAt).toBeNull();
    expect(rowB?.processedAt).toBeNull();
    expect(rowB?.attempts).toBe(1);
    expect(rowB?.nextAttemptAt?.getTime()).toBe(retryAt.getTime());
    expect(rowB?.claimedAt).toBeNull();
  });

  it("is a no-op when both processed and failures are empty", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("noop");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    await manualSave(container, [a], new Date());

    await container.outboxRepository.finalize({
      processed: [],
      failures: [],
      now: new Date(20_000),
    });

    const row = (await container.db.select().from(schema.outboxEvents))[0];
    expect(row?.processedAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.failedAt).toBeNull();
  });
});

describe("D1OutboxRepository.pruneProcessed (integration)", () => {
  it("deletes only rows processed before the cutoff", async () => {
    const container = createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("prune");
    const old = withId(TodoEvents.created(todoId, title, new Date(0)));
    const fresh = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    await manualSave(container, [old, fresh], new Date(0));

    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date(1_000) })
      .where(eq(schema.outboxEvents.id, old.id));
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date(100_000) })
      .where(eq(schema.outboxEvents.id, fresh.id));

    const result = await container.outboxRepository.pruneProcessed(
      new Date(50_000),
    );
    expect(result.deleted).toBe(1);

    const remaining = await container.db.select().from(schema.outboxEvents);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(fresh.id);
  });
});
