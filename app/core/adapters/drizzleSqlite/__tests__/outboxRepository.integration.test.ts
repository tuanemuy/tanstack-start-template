import { eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakeIdGenerator } from "@/core/application/__tests__/fakes";
import { setupTestContainer } from "@/core/application/__tests__/helpers";
import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@/core/domain/common/event";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import * as schema from "../schema";

/**
 * Integration tests for the Drizzle outbox repository.
 *
 * Covers the invariants a fake cannot faithfully reproduce:
 *
 * - Column-level placement of `event_type`, `aggregate_id`, `payload` at
 *   write time.
 * - `claimPending` skips already-processed rows, atomically claims the
 *   batch, hides claimed rows from concurrent claims until the lease
 *   expires, and returns FIFO order.
 * - `markProcessed` only updates pending rows.
 *
 * These tests target the repository directly (`container.outboxRepository`)
 * rather than going through the UoW. The UoW path mints `EventId`s
 * internally, which would hide the ids the assertions need to reference;
 * the repository's `save(events, now)` lets the test stay in control of
 * both ids and timestamps.
 */

const ids = new FakeIdGenerator();
const nextEventId = (): EventId => EventId.create(ids.next());
const nextTodoId = () => TodoId.create(ids.next());
// `TodoEvents.*` factories return identity-less drafts. The UoW would mint
// ids internally, but these repository-direct tests need the ids up-front
// to assert against — so this helper attaches them at construction time.
const withId = <TEvent extends DomainEvent>(
  draft: EventDraft<TEvent>,
): TEvent => ({ ...draft, id: nextEventId() }) as TEvent;

describe("DrizzleSqliteOutboxRepository.save (integration)", () => {
  const getContainer = setupTestContainer();

  it("writes payload / eventType / aggregateId to the correct columns", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("persistence");
    const event = withId(TodoEvents.created(todoId, title, new Date()));

    await container.outboxRepository.save([event], new Date());

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) return;
    expect(row.id).toBe(event.id);
    expect(row.eventType).toBe("todo.created");
    expect(row.aggregateId).toBe(todoId);
    expect(Math.floor(row.occurredAt.getTime() / 1000)).toBe(
      Math.floor(event.occurredAt.getTime() / 1000),
    );
    expect(row.processedAt).toBeNull();

    const stored = row.payload as { todoId: string; title: string };
    expect(stored.todoId).toBe(todoId);
    expect(stored.title).toBe(title);
  });
});

describe("DrizzleSqliteOutboxRepository.claimPending (integration)", () => {
  const getContainer = setupTestContainer();
  const claimArgs = (now: Date, limit = 10) => ({
    limit,
    now,
    workerId: "worker-test",
    leaseMs: 60_000,
  });

  it("returns only unprocessed entries in FIFO order", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("claim");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    await container.outboxRepository.save([a, b], new Date());

    // Mark the first one as already processed — it must NOT be re-listed.
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

  it("returns rows in insertion order when occurredAt is identical", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("ordered");
    const sameTime = new Date(0);
    const a = withId(TodoEvents.created(todoId, title, sameTime));
    const b = withId(TodoEvents.toggled(todoId, true, sameTime));
    const c = withId(TodoEvents.deleted(todoId, sameTime));
    await container.outboxRepository.save([a, b, c], new Date());

    const pending = await container.outboxRepository.claimPending(
      claimArgs(new Date()),
    );
    // FakeIdGenerator hands out monotonically increasing ids, so insertion
    // order is preserved by the (createdAt, id) ordering even when
    // occurredAt ties.
    expect(pending.map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);
  });

  it("hides claimed rows from a concurrent claim until the lease expires", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("lease");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await container.outboxRepository.save([a], new Date());

    const t0 = new Date(1_000_000);
    const first = await container.outboxRepository.claimPending({
      limit: 10,
      now: t0,
      workerId: "worker-A",
      leaseMs: 60_000,
    });
    expect(first.map((e) => e.id)).toEqual([a.id]);

    // Second worker tries to claim within the lease window — must see nothing.
    const stillLeased = new Date(t0.getTime() + 30_000);
    const second = await container.outboxRepository.claimPending({
      limit: 10,
      now: stillLeased,
      workerId: "worker-B",
      leaseMs: 60_000,
    });
    expect(second).toEqual([]);

    // After the lease lapses, the row becomes re-claimable by another worker.
    const afterLease = new Date(t0.getTime() + 60_001);
    const third = await container.outboxRepository.claimPending({
      limit: 10,
      now: afterLease,
      workerId: "worker-B",
      leaseMs: 60_000,
    });
    expect(third.map((e) => e.id)).toEqual([a.id]);
  });

  it("releases the claim on markProcessed so the row is no longer reserved", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("release-on-processed");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await container.outboxRepository.save([a], new Date());

    const t0 = new Date(2_000_000);
    await container.outboxRepository.claimPending({
      limit: 10,
      now: t0,
      workerId: "worker-A",
      leaseMs: 60_000,
    });
    await container.outboxRepository.markProcessed(
      [EventId.create(a.id)],
      new Date(t0.getTime() + 1),
    );

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.claimedAt).toBeNull();
    expect(rows[0]?.claimedBy).toBeNull();
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  it("releases the claim on markFailed so the row is re-claimable once nextAttemptAt elapses", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("release-on-failed");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await container.outboxRepository.save([a], new Date());

    const t0 = new Date(3_000_000);
    await container.outboxRepository.claimPending({
      limit: 10,
      now: t0,
      workerId: "worker-A",
      leaseMs: 60_000,
    });
    const retryAt = new Date(t0.getTime() + 100);
    await container.outboxRepository.markFailed(
      [{ id: a.id, error: "transient", nextAttemptAt: retryAt }],
      new Date(t0.getTime() + 1),
    );

    // After the retry window opens, another worker can claim the row even
    // though the original lease is still nominally active.
    const afterRetry = new Date(retryAt.getTime() + 1);
    const reclaimed = await container.outboxRepository.claimPending({
      limit: 10,
      now: afterRetry,
      workerId: "worker-B",
      leaseMs: 60_000,
    });
    expect(reclaimed.map((e) => e.id)).toEqual([a.id]);
  });

  it("applies a heterogeneous batch of failures in one statement", async () => {
    // Locks down the set-based shape of `markFailed`: each row gets its
    // own error / nextAttemptAt, null-nextAttemptAt rows are quarantined
    // (failed_at = now), non-null-nextAttemptAt rows are scheduled (failed_at
    // stays null), and rows not present in the batch are untouched.
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("bulk-fail");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    const c = withId(TodoEvents.deleted(todoId, new Date(2000)));
    await container.outboxRepository.save([a, b, c], new Date());

    const t0 = new Date(4_000_000);
    await container.outboxRepository.claimPending({
      limit: 10,
      now: t0,
      workerId: "worker-A",
      leaseMs: 60_000,
    });

    const retryAtA = new Date(t0.getTime() + 100);
    const retryAtB = new Date(t0.getTime() + 200);
    const failureNow = new Date(t0.getTime() + 1);
    await container.outboxRepository.markFailed(
      [
        // a: scheduled retry → failed_at must remain null.
        { id: a.id, error: "err-a", nextAttemptAt: retryAtA },
        // b: scheduled retry with a different timestamp/error.
        { id: b.id, error: "err-b", nextAttemptAt: retryAtB },
        // c: budget exhausted → quarantined with failed_at = failureNow.
        { id: c.id, error: "err-c", nextAttemptAt: null },
      ],
      failureNow,
    );

    const rows = await container.db.select().from(schema.outboxEvents);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const rowA = byId.get(a.id);
    expect(rowA?.lastError).toBe("err-a");
    expect(rowA?.nextAttemptAt?.getTime()).toBe(retryAtA.getTime());
    expect(rowA?.failedAt).toBeNull();
    expect(rowA?.attempts).toBe(1);
    expect(rowA?.claimedAt).toBeNull();
    expect(rowA?.claimedBy).toBeNull();

    const rowB = byId.get(b.id);
    expect(rowB?.lastError).toBe("err-b");
    expect(rowB?.nextAttemptAt?.getTime()).toBe(retryAtB.getTime());
    expect(rowB?.failedAt).toBeNull();
    expect(rowB?.attempts).toBe(1);

    const rowC = byId.get(c.id);
    expect(rowC?.lastError).toBe("err-c");
    expect(rowC?.nextAttemptAt).toBeNull();
    expect(rowC?.failedAt?.getTime()).toBe(failureNow.getTime());
    expect(rowC?.attempts).toBe(1);
  });

  it("skips rows in the failures set that are already processed or quarantined", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("bulk-fail-skip");
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(1000)));
    await container.outboxRepository.save([a, b], new Date());

    // a is already finalized — markFailed must not regress it.
    const finalizedAt = new Date(5_000_000);
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: finalizedAt })
      .where(eq(schema.outboxEvents.id, a.id));

    await container.outboxRepository.markFailed(
      [
        { id: a.id, error: "should-be-ignored", nextAttemptAt: null },
        {
          id: b.id,
          error: "applied",
          nextAttemptAt: new Date(5_000_100),
        },
      ],
      new Date(5_000_050),
    );

    const rows = await container.db.select().from(schema.outboxEvents);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // a stays processed — no error, no failed_at, attempts unchanged.
    const rowA = byId.get(a.id);
    expect(rowA?.processedAt?.getTime()).toBe(finalizedAt.getTime());
    expect(rowA?.lastError).toBeNull();
    expect(rowA?.failedAt).toBeNull();
    expect(rowA?.attempts).toBe(0);

    // b is updated normally.
    const rowB = byId.get(b.id);
    expect(rowB?.lastError).toBe("applied");
    expect(rowB?.attempts).toBe(1);
  });
});

describe("DrizzleSqliteOutboxRepository.pruneProcessed (integration)", () => {
  const getContainer = setupTestContainer();

  it("deletes only processed rows older than the cutoff and returns the count", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("prune");

    // Three rows: a (processed long ago), b (processed recently),
    // c (still pending). Cutoff between (a) and (b).
    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    const b = withId(TodoEvents.toggled(todoId, true, new Date(0)));
    const c = withId(TodoEvents.deleted(todoId, new Date(0)));
    await container.outboxRepository.save([a, b, c], new Date());

    const oldProcessedAt = new Date("2020-01-01T00:00:00Z");
    const recentProcessedAt = new Date("2030-01-01T00:00:00Z");
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: oldProcessedAt })
      .where(eq(schema.outboxEvents.id, a.id));
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: recentProcessedAt })
      .where(eq(schema.outboxEvents.id, b.id));

    const cutoff = new Date("2025-01-01T00:00:00Z");
    const { deleted } = await container.outboxRepository.pruneProcessed(cutoff);
    expect(deleted).toBe(1);

    const remaining = await container.db.select().from(schema.outboxEvents);
    const remainingIds = remaining.map((row) => row.id);
    // a is gone; b (processed but newer than cutoff) and c (pending) remain.
    expect(remainingIds).not.toContain(a.id);
    expect(remainingIds).toContain(b.id);
    expect(remainingIds).toContain(c.id);
  });

  it("never deletes pending rows even when the cutoff is in the far future", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("prune-pending");

    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await container.outboxRepository.save([a], new Date());

    // Cutoff that would catch every conceivable processedAt — pending row
    // (processedAt IS NULL) must still survive.
    const farFuture = new Date("9999-01-01T00:00:00Z");
    const { deleted } =
      await container.outboxRepository.pruneProcessed(farFuture);

    expect(deleted).toBe(0);
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(a.id);
    expect(rows[0]?.processedAt).toBeNull();
  });

  it("returns 0 when there are no eligible rows", async () => {
    const container = getContainer();

    const { deleted } = await container.outboxRepository.pruneProcessed(
      new Date("2025-01-01T00:00:00Z"),
    );
    expect(deleted).toBe(0);
  });

  it("treats the cutoff as strict less-than (a row processedAt === cutoff stays)", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("cutoff-boundary");

    const a = withId(TodoEvents.created(todoId, title, new Date(0)));
    await container.outboxRepository.save([a], new Date());

    const exact = new Date("2025-01-01T00:00:00Z");
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: exact })
      .where(eq(schema.outboxEvents.id, a.id));

    const { deleted } = await container.outboxRepository.pruneProcessed(exact);
    expect(deleted).toBe(0);
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
  });
});

describe("DrizzleSqliteOutboxRepository.markProcessed (integration)", () => {
  const getContainer = setupTestContainer();

  it("only marks the given ids and stamps processedAt", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("scoped-mark");
    const a = withId(TodoEvents.created(todoId, title, new Date()));
    const b = withId(TodoEvents.toggled(todoId, true, new Date()));
    await container.outboxRepository.save([a, b], new Date());

    const now = new Date();
    await container.outboxRepository.markProcessed([b.id], now);

    const rows = await container.db.select().from(schema.outboxEvents);
    const aRow = rows.find((r) => r.id === a.id);
    const bRow = rows.find((r) => r.id === b.id);
    expect(aRow?.processedAt).toBeNull();
    expect(bRow?.processedAt).not.toBeNull();
  });

  it("is a no-op when `ids` is empty", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("empty-mark");
    await container.outboxRepository.save(
      [withId(TodoEvents.created(todoId, title, new Date()))],
      new Date(),
    );

    await container.outboxRepository.markProcessed([], new Date());

    const pending = await container.db
      .select()
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(pending).toHaveLength(1);
  });
});
