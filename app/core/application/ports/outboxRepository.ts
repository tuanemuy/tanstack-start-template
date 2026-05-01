import type { DomainEvent } from "@/core/domain/common/event";

export type OutboxEntry = Readonly<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
}>;

export interface OutboxRepository {
  // Must run in the same transaction as the entity changes that produced
  // them — usecases reach this only via `collectEvents`.
  save(events: readonly DomainEvent[]): Promise<void>;

  listPending(limit: number): Promise<readonly OutboxEntry[]>;

  markProcessed(ids: readonly string[], now: Date): Promise<void>;

  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
