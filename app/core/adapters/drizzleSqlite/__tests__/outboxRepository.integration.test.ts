import { eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setupTestContainer } from "@/core/application/__tests__/helpers";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { DrizzleClaimHandle } from "../repositories/outboxRepository";
import * as schema from "../schema";

/**
 * Integration tests for the Drizzle outbox repository.
 *
 * Covers the invariants a fake cannot faithfully reproduce:
 *
 * - Column-level placement of `payload`, `event_type`, `schema_version`,
 *   `aggregate_id` at write time.
 * - Claim / markProcessed scoped to a UUIDv7 lease token.
 * - Stable persisted sequence order for batches emitted in one transaction.
 * - Lease-expiry re-claim behaviour.
 */

// UUIDv7 pattern — matches `TodoId`'s own schema. Used here to assert the
// lease token produced by the adapter rather than hard-coding a specific
// generator implementation.
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("DrizzleSqliteOutboxWriter (integration)", () => {
  const getContainer = setupTestContainer();

  it("saveEvents writes payload/eventType/schemaVersion/aggregateId to the correct columns", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("persistence");
    const event = TodoEvents.created(todoId, title, new Date());

    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([event]);
      },
    );

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) return;
    expect(row.id).toBe(event.id);
    expect(row.eventType).toBe("todo.created");
    expect(row.sequence).toBe(1);
    expect(row.schemaVersion).toBe(1);
    // SQLite's `timestamp` mode stores whole seconds; compare at
    // second granularity to stay within the column's resolution.
    expect(Math.floor(row.occurredAt.getTime() / 1000)).toBe(
      Math.floor(event.occurredAt.getTime() / 1000),
    );
    expect(row.processedAt).toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(row.leasedUntil).toBeNull();

    // The column payload is JSON with shape `{ payload, aggregateId }`.
    const stored = row.payload as {
      payload: { todoId: string; title: string };
      aggregateId: string;
    };
    expect(stored.aggregateId).toBe(todoId);
    expect(stored.payload.todoId).toBe(todoId);
    expect(stored.payload.title).toBe(title);
  });
});

describe("DrizzleSqliteOutboxWorkerRepository.claimPending (integration)", () => {
  const getContainer = setupTestContainer();

  it("returns only unprocessed entries and stamps a UUIDv7 lease token", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("claim");
    const a = TodoEvents.created(todoId, title, new Date());
    const b = TodoEvents.toggled(todoId, true, new Date());
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([a, b]);
      },
    );

    // Mark the first one as already processed — it must NOT be re-claimed.
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.outboxEvents.id, a.id));

    const claim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    expect(claim.entries).toHaveLength(1);
    expect(claim.entries[0]?.id).toBe(b.id);

    // The handle is an opaque `OutboxClaimHandle` to production callers,
    // but adapter-level tests can narrow on the concrete subclass to
    // assert the minted lease token format. Production callers MUST NOT
    // depend on the subclass identity — that is enforced by the port
    // being an abstract base with no public field accessors.
    expect(claim.handle).toBeInstanceOf(DrizzleClaimHandle);
    if (!(claim.handle instanceof DrizzleClaimHandle)) return;
    expect(claim.handle.leaseToken).toMatch(UUID_V7_PATTERN);

    // DB row shows the live lease.
    const rowsAfter = await container.db.select().from(schema.outboxEvents);
    const bRow = rowsAfter.find((r) => r.id === b.id);
    expect(bRow?.leaseToken).toBe(claim.handle.leaseToken);
    expect(bRow?.leasedUntil).not.toBeNull();
  });

  it("claims rows in collectEvents order even when occurredAt ties", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("ordered");
    const sameTime = new Date(0);
    const a = TodoEvents.created(todoId, title, sameTime);
    const b = TodoEvents.toggled(todoId, true, sameTime);
    const c = TodoEvents.deleted(todoId, sameTime);
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([a, b, c]);
      },
    );

    const claim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );

    expect(claim.entries.map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);
    expect(claim.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it("a second concurrent claim with a live lease returns no entries", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("live-lease");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(todoId, title, new Date())]);
      },
    );

    const firstClaim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    expect(firstClaim.entries).toHaveLength(1);

    // A contemporaneous worker must not see the row — it has a live
    // lease from the first claim and `claimPending` filters it out.
    const secondClaim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    expect(secondClaim.entries).toHaveLength(0);
  });

  it("re-claims rows whose lease has expired", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("expired-lease");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(todoId, title, new Date())]);
      },
    );

    // Stamp a past lease as if a previous worker claimed and crashed.
    const pastLease = new Date(Date.now() - 60_000);
    await container.db
      .update(schema.outboxEvents)
      .set({ leaseToken: "stale-token", leasedUntil: pastLease });

    const claim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    expect(claim.entries).toHaveLength(1);

    // Lease token was rotated — the old "stale-token" must be gone.
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows[0]?.leaseToken).not.toBe("stale-token");
  });
});

describe("DrizzleSqliteOutboxWorkerRepository.markProcessed (integration)", () => {
  const getContainer = setupTestContainer();

  it("only marks rows bound to the claim's lease token", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("scoped-mark");
    const a = TodoEvents.created(todoId, title, new Date());
    const b = TodoEvents.toggled(todoId, true, new Date());
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([a, b]);
      },
    );

    const claim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    // Manually overwrite one row's lease token so markProcessed skips it.
    await container.db
      .update(schema.outboxEvents)
      .set({ leaseToken: "different-worker" })
      .where(eq(schema.outboxEvents.id, a.id));

    await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
      outboxRepository.markProcessed(
        claim.handle,
        claim.entries.map((e) => e.id),
      ),
    );

    const rows = await container.db.select().from(schema.outboxEvents);
    const aRow = rows.find((r) => r.id === a.id);
    const bRow = rows.find((r) => r.id === b.id);
    // The mis-scoped row (a) is untouched.
    expect(aRow?.processedAt).toBeNull();
    expect(aRow?.leaseToken).toBe("different-worker");
    // The in-scope row (b) is marked processed and the lease is cleared.
    expect(bRow?.processedAt).not.toBeNull();
    expect(bRow?.leaseToken).toBeNull();
    expect(bRow?.leasedUntil).toBeNull();
  });

  it("is a no-op when `ids` is empty", async () => {
    const container = getContainer();
    const todoId = TodoId.generate();
    const title = TodoTitle.create("empty-mark");
    await container.unitOfWorkProvider.runReadWrite(
      async ({ collectEvents }) => {
        collectEvents([TodoEvents.created(todoId, title, new Date())]);
      },
    );

    const claim = await container.unitOfWorkProvider.runWorker(
      ({ outboxRepository }) =>
        outboxRepository.claimPending(10, 30_000, new Date()),
    );
    await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
      outboxRepository.markProcessed(claim.handle, []),
    );

    // Row remains pending; the lease stays since markProcessed didn't
    // touch it.
    const pending = await container.db
      .select()
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(pending).toHaveLength(1);
  });
});
