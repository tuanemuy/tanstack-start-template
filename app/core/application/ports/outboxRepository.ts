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
// and should be quarantined (excluded from `listPending`); a non-null
// value schedules the next retry.
export type OutboxFailure = Readonly<{
  id: string;
  error: string;
  nextAttemptAt: Date | null;
}>;

export interface OutboxRepository {
  // Must run in the same transaction as the entity changes that produced
  // them — usecases reach this only via `collectEvents`. `now` comes from
  // the application `Clock` so a fake clock freezes outbox `createdAt` too.
  save(events: readonly DomainEvent[], now: Date): Promise<void>;

  // Returns rows that are unprocessed, not quarantined, and whose
  // scheduled `nextAttemptAt` (if any) has elapsed by `now`.
  listPending(limit: number, now: Date): Promise<readonly OutboxEntry[]>;

  markProcessed(ids: readonly EventId[], now: Date): Promise<void>;

  // Increments `attempts`, records the latest error, and either schedules
  // the next retry (`nextAttemptAt`) or quarantines the row by stamping
  // `failedAt = now` (when `nextAttemptAt === null`).
  markFailed(failures: readonly OutboxFailure[], now: Date): Promise<void>;

  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
