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
import type { Executor } from "../client";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

type OutboxEventRow = typeof outboxEvents.$inferSelect;

export class DrizzleSqliteOutboxRepository implements OutboxRepository {
  constructor(
    private readonly executor: Executor,
    private readonly idGenerator: IdGenerator,
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

  async save(events: readonly DomainEvent[], now: Date): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => ({
      id: event.id,
      eventType: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload,
      occurredAt: event.occurredAt,
      createdAt: now,
    }));
    await mapDbError("Failed to save outbox events", () =>
      this.executor.insert(outboxEvents).values(rows),
    );
  }

  async claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]> {
    const { limit, now, workerId, leaseMs } = args;
    // Lease cutoff: a row is re-claimable when its `claimedAt` is at or
    // before this instant (i.e. the prior claim's lease has lapsed).
    const claimCutoff = new Date(now.getTime() - leaseMs);
    return mapDbError("Failed to claim pending outbox events", async () => {
      // The inner SELECT picks eligible rows; the outer UPDATE stamps the
      // claim. SQLite serializes writes at the database level, so even
      // when two workers race here only one transaction's UPDATE
      // succeeds for a given row — the loser's WHERE no longer matches
      // because `claimed_at` is now `>` cutoff. RETURNING gives us the
      // rows we actually claimed.
      const eligibleIds = this.executor
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
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
          ),
        )
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(limit);

      const rows = await this.executor
        .update(outboxEvents)
        .set({ claimedAt: now, claimedBy: workerId })
        .where(inArray(outboxEvents.id, eligibleIds))
        .returning();

      // RETURNING does not preserve the inner ORDER BY; re-sort so the
      // worker observes a stable per-batch FIFO order matching how rows
      // were enqueued.
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
      this.executor
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
      // Set-based bulk update: the port receives a *set* of failures, so
      // apply it as a single statement against a derived relation rather
      // than iterating row-by-row. SQLite 3.33+ supports `UPDATE ... FROM`,
      // and the typed builder cannot express a per-row join, so this drops
      // to a raw template. Bypassing column-mode means timestamp columns
      // must be serialized to ms-since-epoch by hand. Claim is released
      // either way — a row scheduled for retry must be visible to the next
      // claim cycle once its `nextAttemptAt` elapses.
      const tuples = failures.map(
        (failure) =>
          sql`(${failure.id}, ${failure.error}, ${failure.nextAttemptAt === null ? null : failure.nextAttemptAt.getTime()})`,
      );
      const nowMs = now.getTime();
      const t = outboxEvents;
      // CTE column-aliases the VALUES rows: SQLite does not accept
      // `(VALUES ...) AS v(col, ...)`, but `WITH v(col, ...) AS (VALUES ...)`
      // is standard SQL and yields the same join shape.
      await this.executor.run(sql`
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
      const rows = await this.executor
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
