import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdempotencyStore } from "@repo/core/application/ports/idempotencyStore";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type {
  ClaimPendingArgs,
  FinalizeOutboxArgs,
  OutboxEntry,
  OutboxRepository,
} from "@repo/core/application/ports/outboxRepository";
import type { DomainEvent, EventId } from "@repo/core/domain/common/event";
import type { SqlExec, SqlRow } from "./sql";

type OutboxDbRow = Readonly<{
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: string;
  occurred_at: number;
  created_at: number;
  attempts: number;
}> &
  SqlRow;

/**
 * DO-local implementation of `OutboxRepository`, consumed by the SAME
 * `processOutboxEvents` relay worker the other runtimes use — the swap
 * is "where the relay runs" (the DO's alarm instead of a sibling
 * Worker), not the drain policy.
 *
 * A Durable Object is single-threaded, so the claim/lease machinery is
 * not fighting concurrent workers here; it is kept because the port
 * contract still needs it for crash coverage — an alarm invocation
 * that dies between claim and finalize leaves its rows invisible until
 * the lease lapses, at which point the platform-retried alarm picks
 * them up again.
 */
export class DoSqliteOutboxRepository implements OutboxRepository {
  constructor(
    private readonly sql: SqlExec,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  // The commit path inserts outbox rows inside `applyCommit`'s
  // transaction; this method exists to satisfy the port for callers
  // that persist events outside a todo unit of work (none in this
  // template, but the contract requires it to work).
  async save(events: readonly DomainEvent[]): Promise<void> {
    const now = this.clock.now();
    for (const event of events) {
      this.sql.exec(
        `INSERT INTO outbox_events
           (id, event_type, aggregate_id, payload, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        event.id,
        event.type,
        event.aggregateId,
        JSON.stringify(event.payload),
        event.occurredAt.getTime(),
        now.getTime(),
      );
    }
  }

  async claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]> {
    const { limit, now, workerId, leaseMs } = args;
    const claimCutoff = now.getTime() - leaseMs;
    // SELECT then UPDATE without an intervening await — single-threaded
    // execution makes the pair atomic without an explicit transaction.
    const rows = this.sql
      .exec<OutboxDbRow>(
        `SELECT id, event_type, aggregate_id, payload, occurred_at, created_at, attempts
           FROM outbox_events
           WHERE processed_at IS NULL AND failed_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (claimed_at IS NULL OR claimed_at <= ?)
           ORDER BY created_at, id LIMIT ?`,
        now.getTime(),
        claimCutoff,
        limit,
      )
      .toArray();
    for (const row of rows) {
      this.sql.exec(
        "UPDATE outbox_events SET claimed_at = ?, claimed_by = ? WHERE id = ?",
        now.getTime(),
        workerId,
        row.id,
      );
    }
    return rows.map((row) => {
      if (!this.idGenerator.validate(row.id)) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          `Stored outbox event has malformed id: ${row.id}`,
        );
      }
      return {
        id: row.id,
        type: row.event_type,
        payload: JSON.parse(row.payload) as unknown,
        occurredAt: new Date(Number(row.occurred_at)),
        aggregateId: row.aggregate_id,
        attempts: Number(row.attempts),
      };
    });
  }

  async finalize(args: FinalizeOutboxArgs): Promise<void> {
    const { processed, failures, now } = args;
    for (const id of processed) {
      this.sql.exec(
        `UPDATE outbox_events
           SET processed_at = ?, claimed_at = NULL, claimed_by = NULL
           WHERE id = ? AND processed_at IS NULL`,
        now.getTime(),
        id,
      );
    }
    for (const failure of failures) {
      this.sql.exec(
        `UPDATE outbox_events
           SET attempts = attempts + 1,
               last_error = ?,
               next_attempt_at = ?,
               failed_at = ?,
               claimed_at = NULL,
               claimed_by = NULL
           WHERE id = ? AND processed_at IS NULL AND failed_at IS NULL`,
        failure.error,
        failure.nextAttemptAt?.getTime() ?? null,
        failure.nextAttemptAt === null ? now.getTime() : null,
        failure.id,
      );
    }
  }

  async pruneProcessed(olderThan: Date): Promise<{ deleted: number }> {
    const rows = this.sql
      .exec(
        `DELETE FROM outbox_events
           WHERE processed_at IS NOT NULL AND processed_at < ?
           RETURNING id`,
        olderThan.getTime(),
      )
      .toArray();
    return { deleted: rows.length };
  }
}

/**
 * Earliest instant at which a pending outbox row becomes actionable,
 * or `null` when nothing is pending — drives the alarm re-arm after
 * each relay pass. Unclaimed rows are due at `next_attempt_at` (or
 * immediately when fresh); rows still holding a claim — only possible
 * after a crash mid-alarm — become actionable when the lease lapses.
 */
export function nextOutboxWakeUpAt(sql: SqlExec, leaseMs: number): Date | null {
  const rows = sql
    .exec<{ wake: number | null } & SqlRow>(
      `SELECT MIN(CASE WHEN claimed_at IS NOT NULL THEN claimed_at + ?
                       ELSE COALESCE(next_attempt_at, 0) END) AS wake
         FROM outbox_events
         WHERE processed_at IS NULL AND failed_at IS NULL`,
      leaseMs,
    )
    .toArray();
  const wake = rows[0]?.wake;
  return wake === null || wake === undefined ? null : new Date(Number(wake));
}

/**
 * DO-local `processed_events`. The queue consumer Worker reaches this
 * via the DO's `markEventProcessed` RPC — the store lives with the
 * data it guards instead of in a shared database.
 */
export class DoSqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly sql: SqlExec,
    private readonly clock: Clock,
  ) {}

  async markProcessed(id: EventId): Promise<{ alreadyProcessed: boolean }> {
    const rows = this.sql
      .exec(
        `INSERT INTO processed_events (id, processed_at) VALUES (?, ?)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
        id,
        this.clock.now().getTime(),
      )
      .toArray();
    return { alreadyProcessed: rows.length === 0 };
  }
}
