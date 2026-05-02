import type { DomainEvent, EventId } from "@/core/domain/common/event";

// `id` stays as a raw string here: it is the at-rest wire representation
// from the outbox row, validated into `EventId` only when the worker hands
// it to a decoder (so an invalid row fails per-event, not for the batch).
export type OutboxEntry = Readonly<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
}>;

export interface OutboxRepository {
  // Must run in the same transaction as the entity changes that produced
  // them — usecases reach this only via `collectEvents`. `now` comes from
  // the application `Clock` so a fake clock freezes outbox `createdAt` too.
  save(events: readonly DomainEvent[], now: Date): Promise<void>;

  listPending(limit: number): Promise<readonly OutboxEntry[]>;

  markProcessed(ids: readonly EventId[], now: Date): Promise<void>;

  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
