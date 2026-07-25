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
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { outboxEvents } from "../schema";
import { mapDbError } from "./helpers";

/**
 * libSQL `OutboxRepository`. UoW mode (`save`) requires a `PendingBatch`;
 * worker mode (`claimPending` / `finalize` / `pruneProcessed`) runs each
 * call as its own atomic statement or interactive transaction.
 */
export class LibsqlOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly pending: PendingBatch | null = null,
  ) {}

  async save(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.pending === null) {
      throw new Error(
        "LibsqlOutboxRepository.save() called without a PendingBatch — outbox writes must occur inside a UoW",
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
    this.pending.add((tx) => tx.insert(outboxEvents).values(rows));
  }

  async claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]> {
    const { limit, now, workerId, leaseMs } = args;
    const claimCutoff = new Date(now.getTime() - leaseMs);
    return mapDbError("Failed to claim pending outbox events", async () => {
      // Single-statement claim: inner SELECT picks eligible rows in
      // approximate FIFO order, outer UPDATE stamps the claim and
      // RETURNING returns them. libSQL serializes racing writers so two
      // workers see disjoint sets without an outer eligibility recheck.
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

      // RETURNING does not preserve ORDER BY; resort to approximate
      // FIFO (consumers must be idempotent regardless).
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
      // Interactive transaction so a crash mid-call cannot leave
      // failures recorded without their matching successes.
      await this.db.transaction(async (tx) => {
        if (processed.length > 0) {
          await tx
            .update(outboxEvents)
            .set({ processedAt: now, claimedAt: null, claimedBy: null })
            .where(
              and(
                inArray(outboxEvents.id, processed),
                isNull(outboxEvents.processedAt),
              ),
            );
        }
        for (const failure of failures) {
          await tx
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
            );
        }
      });
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
