import type { DomainEvent } from "@/core/domain/common/event";

/**
 * Outbox port. Application-layer (NOT domain) — the outbox is an
 * infrastructural delivery mechanism. Domain code never imports this port.
 *
 * Delivery is at-least-once. Consumers MUST be idempotent (typically keyed
 * on `event.id`). Designed for a single relay worker process; running
 * multiple concurrent workers can double-dispatch.
 */

export type OutboxEntry = Readonly<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
}>;

export interface OutboxRepository {
  /**
   * Persist events. Must run in the same transaction as the entity changes
   * that produced them — usecases reach this only via `collectEvents`.
   */
  save(events: readonly DomainEvent[]): Promise<void>;

  /** Return up to `limit` unprocessed entries in FIFO order. */
  listPending(limit: number): Promise<readonly OutboxEntry[]>;

  /** Stamp `processed_at`. Safe to call with an empty array. */
  markProcessed(ids: readonly string[], now: Date): Promise<void>;

  /**
   * Delete already-processed rows whose `processedAt` is strictly older
   * than `olderThan`. Pending rows are never touched. Safe to run
   * concurrently with the relay worker.
   */
  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
