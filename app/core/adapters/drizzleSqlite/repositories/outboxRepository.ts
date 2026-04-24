import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { SystemError, SystemErrorCode } from "@/core/application/errors";
import type { DomainEvent } from "@/core/domain/common/event";
import {
  type ClaimedOutboxEntry,
  type OutboxClaimBatch,
  OutboxClaimHandle,
  type OutboxEntry,
  type OutboxReader,
  type OutboxWorkerRepository,
  type OutboxWriter,
} from "@/core/domain/common/ports/outboxRepository";
import type { Executor } from "../client";
import { outboxEvents, outboxSequence } from "../schema";
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
 * Drizzle's concrete subclass of the abstract {@link OutboxClaimHandle}.
 *
 * Carries the lease token the adapter needs to scope `markProcessed` to
 * the rows the matching `claimPending` actually leased. Subclassing — not
 * `as unknown` casting — is what proves to the type system that this value
 * implements the opaque port type, so the bookkeeping field stays both
 * private to the adapter AND type-safe.
 *
 * Exported so adapter-level integration tests can `instanceof`-narrow on
 * the runtime class to inspect the minted lease token. Production callers
 * (the relay worker) MUST keep treating the value as opaque.
 */
export class DrizzleClaimHandle extends OutboxClaimHandle {
  constructor(readonly leaseToken: string) {
    super();
  }
}

function rowToEntry(row: OutboxEventRow): OutboxEntry {
  const stored = row.payload as StoredPayload;
  // `aggregateId` is required on `DomainEventBase`, so if the stored row
  // lacks one we fall back to the outbox id — this only happens for legacy
  // rows written before the port made aggregateId required. New rows
  // always have it (the writer no longer allows missing).
  const aggregateId = stored.aggregateId ?? row.id;
  const event: DomainEvent = {
    id: row.id,
    type: row.eventType,
    payload: stored.payload,
    occurredAt: row.occurredAt,
    schemaVersion: row.schemaVersion,
    aggregateId,
  };

  return {
    id: row.id,
    sequence: row.sequence,
    event,
    schemaVersion: row.schemaVersion,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Write-only Drizzle adapter used from usecases through `collectEvents`.
 *
 * Ports: implements {@link OutboxWriter}. Nothing else is exposed, so the
 * read/claim surface cannot be reached from a usecase transaction even if
 * the UoW context accidentally widens in the future.
 */
export class DrizzleSqliteOutboxWriter implements OutboxWriter {
  constructor(protected readonly executor: Executor) {}

  async saveEvents(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    const firstSequence = await this.allocateSequenceBlock(events.length);
    const rows = events.map((event, index) => ({
      id: event.id,
      sequence: firstSequence + index,
      eventType: event.type,
      // Each domain stamps its own `schemaVersion` on the event factory, so
      // the adapter stays domain-agnostic: it writes the value verbatim and
      // never has to know which domains exist.
      schemaVersion: event.schemaVersion,
      payload: {
        payload: event.payload,
        aggregateId: event.aggregateId,
      } satisfies StoredPayload,
      occurredAt: event.occurredAt,
    }));

    await mapDbError("Failed to save outbox events", () =>
      this.executor.insert(outboxEvents).values(rows),
    );
  }

  /**
   * Reserve a contiguous block of `count` sequence numbers for this batch.
   *
   * ## Why this is safe under SQLite (and what to re-check on Turso)
   *
   * Correctness here rests on two assumptions about the underlying engine:
   *
   *   1. **Writer serialization.** SQLite (WAL or rollback journal) only
   *      ever has one writer in flight, so the increment + read on
   *      `outbox_sequence` cannot interleave with another transaction's
   *      increment. Concurrent `saveEvents` calls therefore receive
   *      strictly disjoint, monotonically increasing blocks even though
   *      they race at the application layer.
   *   2. **Statement-level atomicity.** A single `UPDATE ... RETURNING`
   *      observes the value AFTER its own write, so subtracting `count`
   *      yields this batch's first sequence number with no torn read.
   *
   * Workers consume rows ordered by `outbox_events.sequence` (not
   * `occurredAt`), so the order callers pushed events into `collectEvents`
   * is preserved end-to-end through the relay even when multiple events
   * share the same wall-clock timestamp.
   *
   * **Turso / libsql server / any other backend**: the writer-serialization
   * assumption MUST be re-validated. A backend that allows concurrent
   * writers (or reads-then-writes inside one logical transaction without
   * promotion) can hand out overlapping sequence blocks. Switch to a
   * proper sequence object, an `INSERT ... RETURNING rowid`-style strategy,
   * or an explicit `SELECT ... FOR UPDATE` before relying on this code
   * outside local SQLite.
   */
  private async allocateSequenceBlock(count: number): Promise<number> {
    const rows = await mapDbError("Failed to allocate outbox sequence", () =>
      this.executor
        .update(outboxSequence)
        .set({ nextValue: sql`${outboxSequence.nextValue} + ${count}` })
        .where(eq(outboxSequence.id, 1))
        .returning({ nextValue: outboxSequence.nextValue }),
    );
    const nextValue = rows[0]?.nextValue;
    if (nextValue === undefined) {
      throw new Error("outbox_sequence row is missing");
    }
    return nextValue - count;
  }
}

/**
 * Read-only outbox adapter. Currently a thin base — {@link OutboxReader}
 * itself has no methods — but kept as a dedicated class so metrics / admin
 * read paths can be layered on without widening the worker surface.
 */
export class DrizzleSqliteOutboxReader implements OutboxReader {
  constructor(protected readonly executor: Executor) {}
}

/**
 * Worker-only Drizzle adapter exposed exclusively through `runWorker`.
 *
 * Extends {@link DrizzleSqliteOutboxReader} so future read capabilities
 * naturally become available to workers without a second inheritance path.
 *
 * ## Single-statement atomicity
 *
 * `claimPending` uses a subquery-limited UPDATE with the claim predicate
 * repeated on the outer UPDATE, so two concurrent claimants racing on the
 * same id cannot both succeed: the second writer finds the row already
 * stamped with a live lease and the predicate rejects it.
 *
 * ## Deployment assumption
 *
 * Tuned for a single-process deployment with WAL journaling and a non-trivial
 * `busy_timeout` (see the adapter's unit-of-work doc). libsql ignores the
 * IMMEDIATE transaction hint so we cannot force write-lock-on-begin; instead
 * we rely on SQLite's statement-level atomicity and on the
 * `RetryingUnitOfWorkProvider` to absorb transient `SQLITE_BUSY` from
 * contending writers.
 *
 * Delivery semantics: AT-LEAST-ONCE. A worker that crashes after claim but
 * before `markProcessed` will have its lease expire and the rows re-claimed
 * by another worker. Consumers must be idempotent (typically keyed on
 * `event.id`).
 */
export class DrizzleSqliteOutboxWorkerRepository
  extends DrizzleSqliteOutboxReader
  implements OutboxWorkerRepository
{
  async claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<OutboxClaimBatch> {
    // UUIDv7 so concurrently-minted lease tokens sort in time order —
    // useful for log correlation and for the rare cross-process debug
    // where "which worker got the earlier lease?" matters.
    const leaseToken = uuidv7();
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
        .orderBy(asc(outboxEvents.sequence))
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

      const entries: ClaimedOutboxEntry[] = claimed.map((row) => {
        const entry = rowToEntry(row);
        return {
          id: entry.id,
          sequence: entry.sequence,
          event: entry.event,
          schemaVersion: entry.schemaVersion,
        };
      });
      return { entries, handle: new DrizzleClaimHandle(leaseToken) };
    });
  }

  async markProcessed(
    handle: OutboxClaimHandle,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    // Defensive runtime check: a handle minted by a different adapter (or
    // a hand-crafted instance produced by a misuse of an unsafe assertion)
    // would otherwise silently no-op the UPDATE because no row matches a
    // bogus lease token. Failing loudly here turns the mistake into a
    // diagnosable error at the boundary.
    if (!(handle instanceof DrizzleClaimHandle)) {
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        "markProcessed received a handle not minted by this adapter",
      );
    }
    const leaseToken = handle.leaseToken;

    // `WHERE lease_token = ?` prevents a late-arriving caller from
    // overwriting rows that were re-claimed by another worker after the
    // lease expired.
    await mapDbError("Failed to mark outbox events as processed", () =>
      this.executor
        .update(outboxEvents)
        .set({
          processedAt: new Date(),
          leaseToken: null,
          leasedUntil: null,
        })
        .where(
          and(
            inArray(outboxEvents.id, ids as string[]),
            eq(outboxEvents.leaseToken, leaseToken),
          ),
        ),
    );
  }
}
