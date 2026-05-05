import type { DomainEvent, EventId } from "@/core/domain/common/event";

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

export interface OutboxRepository {
  // Must run in the same transaction as the entity changes that produced
  // them — usecases reach this only via `collectEvents`. `now` comes from
  // the application `Clock` so a fake clock freezes outbox `createdAt` too.
  save(events: readonly DomainEvent[], now: Date): Promise<void>;

  // Atomically claims and returns rows that are unprocessed, not
  // quarantined, due for next attempt, and either unclaimed or whose
  // outstanding claim has expired (`claimed_at <= now - leaseMs`). The
  // claim makes the same row invisible to concurrent workers until it
  // is finalized (`markProcessed` / `markFailed`) or its lease lapses,
  // so this is safe for multi-worker deployments.
  claimPending(args: ClaimPendingArgs): Promise<readonly OutboxEntry[]>;

  markProcessed(ids: readonly EventId[], now: Date): Promise<void>;

  // Increments `attempts`, records the latest error, and either schedules
  // the next retry (`nextAttemptAt`) or quarantines the row by stamping
  // `failedAt = now` (when `nextAttemptAt === null`). Releases the claim
  // either way so the row is re-claimable on the next tick.
  markFailed(failures: readonly OutboxFailure[], now: Date): Promise<void>;

  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
