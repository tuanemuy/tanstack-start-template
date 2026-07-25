import type { DomainEvent, EventId } from "@repo/core/domain/common/event";

// `id` stays as a raw string here: it is the at-rest wire representation
// from the outbox row, validated into `EventId` only when the worker hands
// it to a decoder (so an invalid row fails per-event, not for the batch).
// `payload` is `unknown` because the adapter has no way to prove the JSON
// it read from disk matches any shape; the decoder validates it per-row
// via zod, and a mismatch flows through the per-row failure path.
export type OutboxEntry = Readonly<{
  id: string;
  type: string;
  payload: unknown;
  occurredAt: Date;
  aggregateId: string;
  // Number of dispatch/decode failures the relay worker has already
  // recorded for this row. Used to drive backoff and quarantine decisions.
  attempts: number;
}>;

// Per-row failure update applied after a decode or dispatch error.
// `nextAttemptAt === null` means the row has exhausted its retry budget
// and should be quarantined (excluded from `claimPending`); a non-null
// value schedules the next retry.
export type OutboxFailure = Readonly<{
  id: string;
  error: string;
  nextAttemptAt: Date | null;
}>;

// Inputs for an atomic claim-and-list cycle. `workerId` identifies the
// caller for diagnostics; `leaseMs` is the window after which an
// outstanding claim is considered abandoned (covers crashed workers
// without an explicit unclaim step).
export type ClaimPendingArgs = Readonly<{
  limit: number;
  now: Date;
  workerId: string;
  leaseMs: number;
}>;

export type FinalizeOutboxArgs = Readonly<{
  processed: readonly EventId[];
  failures: readonly OutboxFailure[];
  now: Date;
}>;

export interface OutboxRepository {
  // Must run in the same transaction as the entity changes that produced
  // them — usecases reach this only via `collectEvents`. The adapter
  // sources `createdAt` from its own `Clock` so a fake clock freezes
  // outbox timestamps without leaking the parameter through the port.
  save(events: readonly DomainEvent[]): Promise<void>;

  // Atomically claims and returns rows that are unprocessed, not
  // quarantined, due for next attempt, and either unclaimed or whose
  // outstanding claim has expired (`claimed_at <= now - leaseMs`). The
  // claim makes the same row invisible to concurrent workers until it
  // is `finalize`d or its lease lapses, so this is safe for multi-worker
  // deployments. Returned order is approximately FIFO (`created_at, id`);
  // strict enqueue order is not guaranteed — consumers must be idempotent.
  claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]>;

  // Atomically closes a relay tick: a crash mid-call cannot leave
  // failures recorded without the matching successes (or vice versa),
  // so a row whose dispatch already succeeded is never re-claimed.
  finalize(args: FinalizeOutboxArgs): Promise<void>;

  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
