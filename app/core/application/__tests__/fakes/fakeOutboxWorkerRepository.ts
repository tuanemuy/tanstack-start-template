import { v7 as uuidv7 } from "uuid";
import type { DomainEvent } from "@/core/domain/common/event";
import {
  type ClaimedOutboxEntry,
  type OutboxClaimBatch,
  OutboxClaimHandle,
  type OutboxWorkerRepository,
} from "@/core/domain/common/ports/outboxRepository";

/**
 * Shape of a row in the fake outbox. Mirrors the columns the adapter cares
 * about without pretending to be a SQL table.
 */
export type FakeOutboxRow = {
  id: string;
  sequence: number;
  event: DomainEvent;
  schemaVersion: number;
  processedAt: Date | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  occurredAt: Date;
};

/**
 * Fake-side concrete subclass of the abstract {@link OutboxClaimHandle}.
 *
 * Subclassing — not `as unknown` casting — is what proves the value
 * satisfies the opaque port type, mirroring exactly how the production
 * Drizzle adapter mints its own handle. Tests that need to inspect the
 * lease token can `instanceof`-narrow on this class.
 */
export class FakeClaimHandle extends OutboxClaimHandle {
  constructor(readonly leaseToken: string) {
    super();
  }
}

/**
 * In-memory `OutboxWorkerRepository` used in worker-layer unit tests.
 *
 * The rows array is provided by the caller so that a test can seed the store
 * directly (bypassing `collectEvents`) and assert on the post-run state. The
 * claim/mark-processed semantics match the production adapter at the level
 * the relay worker depends on:
 *
 * - `claimPending` filters for `processedAt === null` and either no lease or
 *   an expired lease, stamps a fresh UUIDv7 lease token, and returns the
 *   entries wrapped in an opaque handle.
 * - `markProcessed` scopes the update to the handle's lease token so stale
 *   callers do not clobber rows re-claimed by another fake worker.
 *
 * Intentionally NOT modelled: transactional rollback. A partial failure
 * mid-claim is not something the worker-level tests need to exercise; the
 * adapter-level integration tests cover that against real SQLite.
 */
export class FakeOutboxWorkerRepository implements OutboxWorkerRepository {
  constructor(private readonly rows: FakeOutboxRow[]) {}

  async claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<OutboxClaimBatch> {
    const leaseToken = uuidv7();
    const leasedUntil = new Date(now.getTime() + leaseDurationMs);

    // FIFO by persisted insertion sequence, matching the real adapter's ORDER BY.
    const candidates = this.rows
      .filter(
        (row) =>
          row.processedAt === null &&
          (row.leasedUntil === null ||
            row.leasedUntil.getTime() < now.getTime()),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, batchSize);

    const claimed: ClaimedOutboxEntry[] = [];
    for (const row of candidates) {
      row.leaseToken = leaseToken;
      row.leasedUntil = leasedUntil;
      claimed.push({
        id: row.id,
        sequence: row.sequence,
        event: row.event,
        schemaVersion: row.schemaVersion,
      });
    }

    return { entries: claimed, handle: new FakeClaimHandle(leaseToken) };
  }

  async markProcessed(
    handle: OutboxClaimHandle,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    // Defensive runtime check mirrors the production adapter: a wrong-shape
    // handle deterministically fails here instead of silently no-oping.
    if (!(handle instanceof FakeClaimHandle)) {
      throw new Error(
        "FakeOutboxWorkerRepository.markProcessed received a foreign handle",
      );
    }
    const leaseToken = handle.leaseToken;
    const idSet = new Set(ids);
    for (const row of this.rows) {
      if (!idSet.has(row.id)) continue;
      // Scope the write to the claim's lease token — simulates `WHERE
      // lease_token = ?` so that a late caller cannot overwrite rows that
      // were re-claimed by a different fake worker.
      if (row.leaseToken !== leaseToken) continue;
      row.processedAt = new Date();
      row.leaseToken = null;
      row.leasedUntil = null;
    }
  }
}
