import { and, asc, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type {
  OutboxEntry,
  OutboxRepository,
} from "@/core/application/ports/outboxRepository";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Executor } from "../client";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

type OutboxEventRow = typeof outboxEvents.$inferSelect;

function rowToEntry(row: OutboxEventRow): OutboxEntry {
  return {
    id: row.id,
    type: row.eventType,
    payload: row.payload as Record<string, unknown>,
    occurredAt: row.occurredAt,
    aggregateId: row.aggregateId,
  };
}

/**
 * Drizzle-backed `OutboxRepository`. The `Executor` may be a transaction
 * handle (UoW flush) or the bare DB (relay worker reads / mark-processed).
 */
export class DrizzleSqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly executor: Executor) {}

  async save(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => ({
      id: event.id,
      eventType: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload,
      occurredAt: event.occurredAt,
    }));
    await mapDbError("Failed to save outbox events", () =>
      this.executor.insert(outboxEvents).values(rows),
    );
  }

  async listPending(limit: number): Promise<readonly OutboxEntry[]> {
    return mapDbError("Failed to list pending outbox events", async () => {
      const rows = await this.executor
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.processedAt))
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(limit);
      return rows.map(rowToEntry);
    });
  }

  async markProcessed(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await mapDbError("Failed to mark outbox events as processed", () =>
      this.executor
        .update(outboxEvents)
        .set({ processedAt: now })
        .where(
          and(
            inArray(outboxEvents.id, ids as string[]),
            isNull(outboxEvents.processedAt),
          ),
        ),
    );
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
