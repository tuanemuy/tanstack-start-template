import {
  and,
  asc,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { SystemError, SystemErrorCode } from "@/core/application/errors";
import type { IdGenerator } from "@/core/application/ports/idGenerator";
import type {
  ClaimPendingArgs,
  OutboxEntry,
  OutboxFailure,
  OutboxRepository,
} from "@/core/application/ports/outboxRepository";
import type { DomainEvent, EventId } from "@/core/domain/common/event";
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

type OutboxEventRow = typeof outboxEvents.$inferSelect;

/**
 * D1 implementation of `OutboxRepository`.
 *
 * Two operating modes share one class because the port is a single
 * contract:
 *
 * - **Inside a unit of work** — `save` is invoked only here, via the
 *   UoW's `collectEvents` plumbing, and the writes must commit
 *   atomically with the aggregate writes. The instance is constructed
 *   with a `PendingBatch` and `save` enqueues onto it.
 *
 * - **Relay worker** — `claimPending` / `markProcessed` / `markFailed` /
 *   `pruneProcessed` run outside any UoW, each as its own atomic
 *   `db.batch()` (or single statement). The instance is constructed
 *   without a `PendingBatch`.
 *
 * Calling `save` without a `PendingBatch` is a programming error and
 * throws — there is no scenario where outbox writes legitimately bypass
 * the UoW.
 */
export class D1OutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly idGenerator: IdGenerator,
    private readonly pending: PendingBatch | null = null,
  ) {}

  private rowToEntry(row: OutboxEventRow): OutboxEntry {
    if (!this.idGenerator.validate(row.id)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored outbox event has malformed id: ${row.id}`,
      );
    }
    return {
      id: row.id,
      type: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      aggregateId: row.aggregateId,
      attempts: row.attempts,
    };
  }

  // Buffered. Must be called from inside a UoW so the events land in
  // the same `db.batch()` as the aggregate writes that produced them.
  async save(events: readonly DomainEvent[], now: Date): Promise<void> {
    if (events.length === 0) return;
    if (this.pending === null) {
      throw new Error(
        "D1OutboxRepository.save() called without a PendingBatch — outbox writes must occur inside a UoW",
      );
    }
    const rows = events.map((event) => ({
      id: event.id,
      eventType: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload,
      occurredAt: event.occurredAt,
      createdAt: now,
    }));
    this.pending.add(this.db.insert(outboxEvents).values(rows));
  }

  async claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]> {
    const { limit, now, workerId, leaseMs } = args;
    const claimCutoff = new Date(now.getTime() - leaseMs);
    return mapDbError("Failed to claim pending outbox events", async () => {
      // Inner SELECT picks eligible rows; the outer UPDATE re-checks
      // the same eligibility predicates so that two workers racing on
      // the same tick can never both stamp the same row. SQLite/D1 do
      // not guarantee an `IN (subquery)` is evaluated exactly once, so
      // the redundancy is the correctness guarantee — not the comment
      // about write serialization.
      const eligible = and(
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.failedAt),
        or(
          isNull(outboxEvents.nextAttemptAt),
          lte(outboxEvents.nextAttemptAt, now),
        ),
        or(
          isNull(outboxEvents.claimedAt),
          lte(outboxEvents.claimedAt, claimCutoff),
        ),
      );

      const eligibleIds = this.db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eligible)
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(limit);

      const rows = await this.db
        .update(outboxEvents)
        .set({ claimedAt: now, claimedBy: workerId })
        .where(and(inArray(outboxEvents.id, eligibleIds), eligible))
        .returning();

      // RETURNING does not preserve the inner ORDER BY; re-sort so the
      // worker observes a stable per-batch FIFO order matching how
      // rows were enqueued.
      const sorted = [...rows].sort((a, b) => {
        const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
        if (byCreated !== 0) return byCreated;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return sorted.map((row) => this.rowToEntry(row));
    });
  }

  async markProcessed(ids: readonly EventId[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await mapDbError("Failed to mark outbox events as processed", () =>
      this.db
        .update(outboxEvents)
        .set({ processedAt: now, claimedAt: null, claimedBy: null })
        .where(
          and(inArray(outboxEvents.id, ids), isNull(outboxEvents.processedAt)),
        ),
    );
  }

  async markFailed(
    failures: readonly OutboxFailure[],
    now: Date,
  ): Promise<void> {
    if (failures.length === 0) return;
    await mapDbError("Failed to mark outbox events as failed", async () => {
      // Set-based bulk update via `WITH v(...) AS (VALUES ...) UPDATE ... FROM v`.
      // SQLite 3.33+ supports this and D1's underlying SQLite is recent
      // enough. Timestamp columns are serialized to ms-since-epoch by hand
      // because dropping to a raw template bypasses Drizzle's column-mode
      // codec. Claim is released either way — a row scheduled for retry
      // must be visible to the next claim cycle once `next_attempt_at`
      // elapses.
      const tuples = failures.map(
        (failure) =>
          sql`(${failure.id}, ${failure.error}, ${failure.nextAttemptAt === null ? null : failure.nextAttemptAt.getTime()})`,
      );
      const nowMs = now.getTime();
      const t = outboxEvents;
      await this.db.run(sql`
        WITH v(id, error, next_attempt_at) AS (VALUES ${sql.join(tuples, sql`, `)})
        UPDATE ${t}
        SET attempts = ${t.attempts} + 1,
            last_error = v.error,
            next_attempt_at = v.next_attempt_at,
            failed_at = CASE WHEN v.next_attempt_at IS NULL THEN ${nowMs} ELSE NULL END,
            claimed_at = NULL,
            claimed_by = NULL
        FROM v
        WHERE ${t.id} = v.id
          AND ${t.processedAt} IS NULL
          AND ${t.failedAt} IS NULL
      `);
    });
  }

  async pruneProcessed(olderThan: Date): Promise<{ deleted: number }> {
    return mapDbError("Failed to prune processed outbox events", async () => {
      const rows = await this.db
        .delete(outboxEvents)
        .where(
          and(
            isNotNull(outboxEvents.processedAt),
            lt(outboxEvents.processedAt, olderThan),
          ),
        )
        .returning({ id: outboxEvents.id });
      return { deleted: rows.length };
    });
  }
}
