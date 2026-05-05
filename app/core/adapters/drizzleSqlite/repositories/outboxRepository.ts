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
import { SystemError, SystemErrorCode } from "@/core/application/errors";
import { isUuidV7 } from "@/core/application/ports/idGenerator";
import type {
  OutboxEntry,
  OutboxFailure,
  OutboxRepository,
} from "@/core/application/ports/outboxRepository";
import type { DomainEvent, EventId } from "@/core/domain/common/event";
import type { Executor } from "../client";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

type OutboxEventRow = typeof outboxEvents.$inferSelect;

function rowToEntry(row: OutboxEventRow): OutboxEntry {
  if (!isUuidV7(row.id)) {
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

export class DrizzleSqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly executor: Executor) {}

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

  async listPending(limit: number, now: Date): Promise<readonly OutboxEntry[]> {
    return mapDbError("Failed to list pending outbox events", async () => {
      const rows = await this.executor
        .select()
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.failedAt),
            or(
              isNull(outboxEvents.nextAttemptAt),
              lte(outboxEvents.nextAttemptAt, now),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(limit);
      return rows.map(rowToEntry);
    });
  }

  async markProcessed(ids: readonly EventId[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await mapDbError("Failed to mark outbox events as processed", () =>
      this.executor
        .update(outboxEvents)
        .set({ processedAt: now })
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
      // One UPDATE per row: per-row `error` and `nextAttemptAt` differ, and
      // batching them into a single CASE expression buys little for the
      // batch sizes the relay worker hands us. Stays inside the surrounding
      // executor (transactional when the caller wrapped it).
      for (const failure of failures) {
        await this.executor
          .update(outboxEvents)
          .set({
            attempts: sql`${outboxEvents.attempts} + 1`,
            lastError: failure.error,
            nextAttemptAt: failure.nextAttemptAt,
            failedAt: failure.nextAttemptAt === null ? now : null,
          })
          .where(
            and(
              eq(outboxEvents.id, failure.id),
              isNull(outboxEvents.processedAt),
              isNull(outboxEvents.failedAt),
            ),
          );
      }
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
