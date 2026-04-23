import type { DomainEvent } from "../event";

/**
 * An entry stored in the outbox table.
 *
 * Each entry wraps a single domain event plus metadata needed for reliable
 * delivery (processed marker, lease metadata, creation timestamp).
 */
export type OutboxEntry = Readonly<{
  id: string;
  event: DomainEvent;
  schemaVersion: number;
  processedAt: Date | null;
  createdAt: Date;
}>;

/**
 * An outbox entry that has been claimed by a worker. Exposes the
 * `leaseToken` so that `markProcessed` can scope its update to the same
 * lease holder (other workers that re-claimed the row after a lease
 * expiry are invisible to this caller).
 */
export type ClaimedOutboxEntry = OutboxEntry &
  Readonly<{
    leaseToken: string;
  }>;

/**
 * Read-only view of the outbox.
 *
 * A readonly unit of work exposes only this interface so that usecases
 * running in `{ mode: "readonly" }` cannot persist or claim events at the
 * type level.
 */
export interface OutboxReader {
  /**
   * Read-only helper: returns unprocessed entries ordered by `occurredAt`.
   *
   * Does NOT claim entries. Concurrent workers using this method will
   * double-dispatch. For production relay use {@link OutboxRepository.claimPending}.
   */
  findPendingEvents(limit: number): Promise<readonly OutboxEntry[]>;
}

/**
 * Full read/write outbox port.
 *
 * Implementations MUST participate in the transactional executor that their
 * owning unit of work provides, so that `saveEvents` runs in the same
 * transaction as the entity changes that produced those events.
 *
 * Delivery guarantee: AT-LEAST-ONCE. Consumers of claimed events must be
 * idempotent (typically keyed on `event.id`). Crashes between dispatch and
 * `markProcessed` are the canonical source of redelivery.
 */
export interface OutboxRepository extends OutboxReader {
  /**
   * Persist the given domain events to the outbox. Must be invoked inside the
   * same transaction that produced the events.
   */
  saveEvents(events: readonly DomainEvent[]): Promise<void>;

  /**
   * Atomically claim up to `batchSize` unprocessed entries whose existing
   * lease has expired (or which have never been claimed). Returns the claimed
   * entries stamped with a fresh `leaseToken`. Safe to call from concurrent
   * workers — each row is claimed by exactly one caller for the duration of
   * `leaseDurationMs`.
   *
   * If dispatch fails or the worker crashes, the lease will expire and another
   * worker can re-claim the entry. This is at-least-once delivery.
   */
  claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<readonly ClaimedOutboxEntry[]>;

  /**
   * Mark the given claimed entries as processed. The update is scoped to
   * rows whose `lease_token` still matches the token supplied for that id,
   * so an entry whose lease expired and was re-claimed by another worker is
   * left untouched (preventing a late-arriving worker from silently
   * dropping work that a fresh claimant is still dispatching).
   */
  markProcessed(
    entries: readonly Pick<ClaimedOutboxEntry, "id" | "leaseToken">[],
  ): Promise<void>;
}
