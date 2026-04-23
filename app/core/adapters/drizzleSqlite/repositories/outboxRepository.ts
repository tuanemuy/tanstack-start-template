import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { DomainEvent } from "@/core/domain/common/event";
import type {
  ClaimedOutboxEntry,
  OutboxEntry,
  OutboxRepository,
} from "@/core/domain/common/ports/outboxRepository";
import type { Executor } from "../client";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

type OutboxEventRow = typeof outboxEvents.$inferSelect;

/**
 * Shape of the JSON `payload` column. The event `type` is NOT duplicated here —
 * it lives in the top-level `event_type` column exclusively. `schemaVersion`
 * lives in its own column so adapters/consumers can branch on it without
 * parsing JSON first.
 */
type StoredPayload = {
  payload: Record<string, unknown>;
  aggregateId?: string;
};

function rowToEntry(row: OutboxEventRow): OutboxEntry {
  const stored = row.payload as StoredPayload;
  const event: DomainEvent = {
    id: row.id,
    type: row.eventType,
    payload: stored.payload,
    occurredAt: row.occurredAt,
    schemaVersion: row.schemaVersion,
    ...(stored.aggregateId !== undefined
      ? { aggregateId: stored.aggregateId }
      : {}),
  };

  return {
    id: row.id,
    event,
    schemaVersion: row.schemaVersion,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Drizzle implementation of `OutboxRepository`.
 */
export class DrizzleSqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly executor: Executor) {}

  async saveEvents(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    const rows = events.map((event) => ({
      id: event.id,
      eventType: event.type,
      // Each domain stamps its own `schemaVersion` on the event factory, so
      // the adapter stays domain-agnostic: it writes the value verbatim and
      // never has to know which domains exist.
      schemaVersion: event.schemaVersion,
      payload: {
        payload: event.payload,
        ...(event.aggregateId !== undefined
          ? { aggregateId: event.aggregateId }
          : {}),
      } satisfies StoredPayload,
      occurredAt: event.occurredAt,
    }));

    await mapDbError("Failed to save outbox events", () =>
      this.executor.insert(outboxEvents).values(rows),
    );
  }

  /**
   * Atomically claim a batch of pending (or expired-lease) outbox entries by
   * stamping them with a fresh lease token + expiry, then returning the
   * claimed rows via `RETURNING`.
   *
   * ## Single-statement atomicity
   *
   * The UPDATE carries the same `processed_at IS NULL AND (leased_until IS
   * NULL OR leased_until < now)` predicate as the candidate-id subquery. If
   * two claimants racing from separate transactions both pick up the same
   * candidate id, only the first to commit can satisfy the predicate at
   * apply time — the loser writes zero rows and its `RETURNING` payload is
   * empty for those ids, so the claim sets are always disjoint.
   *
   * ## Deployment assumption
   *
   * Tuned for a single-process deployment with WAL journaling and a
   * non-trivial `busy_timeout` (see the adapter's unit-of-work doc). libsql
   * ignores the IMMEDIATE transaction hint so we can't force
   * write-lock-on-begin; instead we rely on SQLite's statement-level
   * atomicity and on the `RetryingUnitOfWorkProvider` to absorb transient
   * `SQLITE_BUSY` from contending writers.
   *
   * Delivery semantics: AT-LEAST-ONCE. A worker that crashes after claim but
   * before `markProcessed` will have its lease expire and the rows re-claimed
   * by another worker. Consumers must be idempotent.
   */
  async claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<readonly ClaimedOutboxEntry[]> {
    const leaseToken = randomUUID();
    const leasedUntil = new Date(now.getTime() + leaseDurationMs);

    return mapDbError("Failed to claim pending outbox events", async () => {
      // Select candidate ids in a subquery for FIFO ordering. The UPDATE
      // below carries the SAME pending/expired-lease predicate so that two
      // concurrent claimants racing on the same id cannot both succeed:
      // the second writer finds the row already stamped with a live lease
      // and the predicate rejects it.
      const candidateIds = this.executor
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.processedAt),
            or(
              isNull(outboxEvents.leasedUntil),
              lt(outboxEvents.leasedUntil, now),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.occurredAt))
        .limit(batchSize);

      const claimed = await this.executor
        .update(outboxEvents)
        .set({ leaseToken, leasedUntil })
        .where(
          and(
            inArray(outboxEvents.id, candidateIds),
            isNull(outboxEvents.processedAt),
            or(
              isNull(outboxEvents.leasedUntil),
              lt(outboxEvents.leasedUntil, now),
            ),
          ),
        )
        .returning();

      return claimed.map((row) => {
        const entry = rowToEntry(row);
        return { ...entry, leaseToken };
      });
    });
  }

  /**
   * Mark the given claimed entries as processed, scoped to rows whose
   * `lease_token` still matches the value the caller was holding.
   *
   * Because `claimPending` stamps every row in a single batch with the same
   * token, we can group by token and issue one UPDATE per distinct token.
   * The `WHERE lease_token = ?` clause prevents a late-arriving caller from
   * overwriting rows that were re-claimed by another worker after the lease
   * expired.
   */
  async markProcessed(
    entries: readonly Pick<ClaimedOutboxEntry, "id" | "leaseToken">[],
  ): Promise<void> {
    if (entries.length === 0) return;

    const byToken = new Map<string, string[]>();
    for (const entry of entries) {
      const bucket = byToken.get(entry.leaseToken) ?? [];
      bucket.push(entry.id);
      byToken.set(entry.leaseToken, bucket);
    }

    await mapDbError("Failed to mark outbox events as processed", async () => {
      for (const [token, ids] of byToken) {
        await this.executor
          .update(outboxEvents)
          .set({
            processedAt: new Date(),
            leaseToken: null,
            leasedUntil: null,
          })
          .where(
            and(
              inArray(outboxEvents.id, ids),
              eq(outboxEvents.leaseToken, token),
            ),
          );
      }
    });
  }
}
