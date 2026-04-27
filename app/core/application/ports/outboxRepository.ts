import type { DomainEvent } from "@/core/domain/common/event";

/**
 * Outbox port — application-layer (NOT domain).
 *
 * The outbox is an infrastructural delivery mechanism for cross-aggregate
 * publishing, not a domain concept. Domain code never imports this port; the
 * only legitimate writers are the application layer's UoW flush (via
 * `collectEvents`) and the event relay worker.
 */

/**
 * A pending entry stored in the outbox table.
 *
 * Returned by {@link OutboxRepository.listPending} so the relay worker can
 * decode + dispatch each row. `payload` arrives as a plain JSON object — the
 * domain decoder re-runs each field through its value-object factory.
 */
export type OutboxEntry = Readonly<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
}>;

/**
 * Outbox repository.
 *
 * Single port intentionally — the surface is small enough that splitting it
 * into reader / writer / worker layers would just add ceremony for a template.
 *
 * ## Delivery semantics: at-least-once
 *
 * If dispatch succeeds but `markProcessed` fails — or the worker crashes
 * between the two — the row stays pending and a later run dispatches it
 * again. **Consumers MUST be idempotent**, typically keyed on `event.id`.
 *
 * ## Concurrency
 *
 * The repository is designed for a single relay worker process. Running
 * multiple workers concurrently can cause double dispatch (acceptable under
 * at-least-once but wasteful). If you scale out, layer a lease / claim
 * mechanism on top.
 */
export interface OutboxRepository {
  /**
   * Persist the given domain events to the outbox. MUST run in the same
   * transaction as the entity changes that produced them so that a commit
   * publishes events atomically. Usecases never call this directly — events
   * flow in through `collectEvents` on the unit-of-work context.
   */
  save(events: readonly DomainEvent[]): Promise<void>;

  /**
   * Return up to `limit` unprocessed entries in FIFO order (oldest first).
   * The relay worker decodes and dispatches them, then calls
   * {@link markProcessed} with the ids that succeeded.
   */
  listPending(limit: number): Promise<readonly OutboxEntry[]>;

  /**
   * Mark the given entry ids as processed. Called by the relay worker after
   * successful dispatch. Safe to call with an empty array.
   */
  markProcessed(ids: readonly string[], now: Date): Promise<void>;

  /**
   * Delete already-processed rows whose `processedAt` is strictly older than
   * `olderThan`. Pending rows (`processedAt IS NULL`) are never touched.
   *
   * Returns the number of rows deleted so callers can log / report. Safe to
   * run concurrently with the relay worker — a row only becomes a prune
   * candidate after `markProcessed` has stamped it.
   *
   * The cutoff is policy that lives at the call site (typically
   * `pruneOutbox` in `app/core/application/workers/outboxPrune.ts`). The
   * repository merely executes the SQL.
   */
  pruneProcessed(olderThan: Date): Promise<{ deleted: number }>;
}
