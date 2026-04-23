import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { DomainEvent } from "@/core/domain/common/event";
import type {
  ClaimedOutboxEntry,
  OutboxEntry,
  OutboxReader,
  OutboxRepository,
} from "@/core/domain/common/ports/outboxRepository";
import { TODO_EVENT_SCHEMA_VERSION } from "@/core/domain/todo/events";
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

/**
 * Map a domain event's `type` to the schema version this process knows how
 * to emit. Consumers that accept older versions branch on `schemaVersion`
 * inside their per-domain decode function.
 */
function schemaVersionFor(type: string): number {
  if (type.startsWith("todo.")) return TODO_EVENT_SCHEMA_VERSION;
  // Default: v1. Domains that evolve their wire format register an explicit
  // branch here so the write path stamps the right version.
  return 1;
}

function rowToEntry(row: OutboxEventRow): OutboxEntry {
  const stored = row.payload as StoredPayload;
  const event: DomainEvent = {
    id: row.id,
    type: row.eventType,
    payload: stored.payload,
    occurredAt: row.occurredAt,
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
 * Read-only Drizzle implementation of `OutboxReader`.
 */
export class DrizzleSqliteOutboxReader implements OutboxReader {
  constructor(protected readonly executor: Executor) {}

  findPendingEvents(limit: number): Promise<readonly OutboxEntry[]> {
    return mapDbError("Failed to find pending outbox events", async () => {
      const rows = await this.executor
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.processedAt))
        .orderBy(asc(outboxEvents.occurredAt))
        .limit(limit);
      return rows.map(rowToEntry);
    });
  }
}

/**
 * Read/write Drizzle implementation of `OutboxRepository`.
 */
export class DrizzleSqliteOutboxRepository
  extends DrizzleSqliteOutboxReader
  implements OutboxRepository
{
  async saveEvents(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    const rows = events.map((event) => ({
      id: event.id,
      eventType: event.type,
      schemaVersion: schemaVersionFor(event.type),
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
      // Select candidate ids in a subquery so the UPDATE touches only those
      // rows, preserving FIFO order via `occurred_at ASC`.
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
        .where(inArray(outboxEvents.id, candidateIds))
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
