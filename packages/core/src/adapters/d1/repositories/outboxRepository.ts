import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type {
  ClaimPendingArgs,
  FinalizeOutboxArgs,
  OutboxEntry,
  OutboxRepository,
} from "@repo/core/application/ports/outboxRepository";
import type { DomainEvent } from "@repo/core/domain/common/event";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

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
 * - **Relay worker** — `claimPending` / `finalize` / `pruneProcessed`
 *   run outside any UoW, each as its own atomic `db.batch()` (or
 *   single statement). The instance is constructed without a
 *   `PendingBatch`.
 *
 * Calling `save` without a `PendingBatch` is a programming error and
 * throws — there is no scenario where outbox writes legitimately bypass
 * the UoW.
 */
export class D1OutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly pending: PendingBatch | null = null,
  ) {}

  // Buffered. Must be called from inside a UoW so the events land in
  // the same `db.batch()` as the aggregate writes that produced them.
  async save(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.pending === null) {
      throw new Error(
        "D1OutboxRepository.save() called without a PendingBatch — outbox writes must occur inside a UoW",
      );
    }
    const now = this.clock.now();
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
      // Single-statement claim: an inner SELECT picks the oldest
      // eligible rows (approximately FIFO via `created_at, id` — events
      // sharing a `created_at` ms tiebreak on UUIDv7's random suffix, so
      // per-ms order is not arrival order), and the outer UPDATE
      // stamps the claim and returns the rows. Drizzle inlines the
      // unawaited select builder as a subquery inside `WHERE id IN
      // (...)`, so the whole thing compiles to one statement. Under
      // SQLite's write lock, two workers racing on the same tick are
      // serialized by the engine — the second observes the first's
      // claim already committed, so its inner SELECT returns a
      // disjoint set. No outer eligibility re-check is needed. (D1
      // rejects `UPDATE ... ORDER BY ... LIMIT ... RETURNING` even
      // though SQLite's grammar allows it, so the LIMIT lives on the
      // inner SELECT.)
      const eligibleIds = this.db
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

      const rows = await this.db
        .update(outboxEvents)
        .set({ claimedAt: now, claimedBy: workerId })
        .where(inArray(outboxEvents.id, eligibleIds))
        .returning({
          id: outboxEvents.id,
          eventType: outboxEvents.eventType,
          aggregateId: outboxEvents.aggregateId,
          payload: outboxEvents.payload,
          occurredAt: outboxEvents.occurredAt,
          createdAt: outboxEvents.createdAt,
          attempts: outboxEvents.attempts,
        });

      // RETURNING does not preserve the UPDATE's ORDER BY; re-sort to
      // match the inner SELECT's `created_at, id` order. Per-ms tiebreak
      // is UUIDv7's random suffix, so this is approximate FIFO — strict
      // enqueue order is not guaranteed (consumers must be idempotent).
      const sorted = [...rows].sort((a, b) => {
        const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
        if (byCreated !== 0) return byCreated;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return sorted.map((row) => {
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
      });
    });
  }

  async finalize(args: FinalizeOutboxArgs): Promise<void> {
    const { processed, failures, now } = args;
    if (processed.length === 0 && failures.length === 0) return;
    await mapDbError("Failed to finalize outbox events", async () => {
      // Per-row `update()` for failures rather than a set-based
      // `WITH v(...) AS (VALUES ...)` bulk update: Drizzle's
      // `db.run(sql\`...\`)` returns a `SQLiteRaw` whose `_prepare()`
      // skips `session.prepareQuery`, so a parameterized raw query has
      // no `stmt` for `db.batch()` to `bind` against.
      const items: BatchItem<"sqlite">[] = [];
      if (processed.length > 0) {
        items.push(
          this.db
            .update(outboxEvents)
            .set({ processedAt: now, claimedAt: null, claimedBy: null })
            .where(
              and(
                inArray(outboxEvents.id, processed),
                isNull(outboxEvents.processedAt),
              ),
            ),
        );
      }
      for (const failure of failures) {
        items.push(
          this.db
            .update(outboxEvents)
            .set({
              attempts: sql`${outboxEvents.attempts} + 1`,
              lastError: failure.error,
              nextAttemptAt: failure.nextAttemptAt,
              failedAt: failure.nextAttemptAt === null ? now : null,
              claimedAt: null,
              claimedBy: null,
            })
            .where(
              and(
                eq(outboxEvents.id, failure.id),
                isNull(outboxEvents.processedAt),
                isNull(outboxEvents.failedAt),
              ),
            ),
        );
      }
      if (items.length === 1) {
        const [only] = items as [BatchItem<"sqlite">];
        await only;
        return;
      }
      await this.db.batch(
        items as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
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
