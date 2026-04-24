import type { DomainEvent } from "../event";

/**
 * An entry stored in the outbox table.
 *
 * Each entry wraps a single domain event plus metadata needed for reliable
 * delivery (processed marker, creation timestamp).
 */
export type OutboxEntry = Readonly<{
  id: string;
  sequence: number;
  event: DomainEvent;
  schemaVersion: number;
  processedAt: Date | null;
  createdAt: Date;
}>;

/**
 * An outbox entry that has been claimed by a worker. Exposes only the
 * minimal shape relay code needs (`id`, `event`, `schemaVersion`) — the
 * per-claim lease token is kept as the adapter's internal bookkeeping and
 * returned to the worker through an opaque {@link OutboxClaimHandle}, so
 * the domain port never leaks the "lease_token string" representation.
 */
export type ClaimedOutboxEntry = Readonly<{
  id: string;
  sequence: number;
  event: DomainEvent;
  schemaVersion: number;
}>;

/**
 * Opaque handle returned by {@link OutboxWorkerRepository.claimPending}.
 *
 * ## Why an abstract class instead of a branded type?
 *
 * Earlier iterations modelled this as a branded structural type and forced
 * adapters to `as unknown as OutboxClaimHandle` their internal bookkeeping
 * onto it — the brand was supposed to keep callers honest, but the cast
 * silently disabled the protection on the adapter side. An abstract class
 * with a `private` field gives us nominal typing for free: any subclass
 * automatically satisfies the `OutboxClaimHandle` type, and any object that
 * is NOT a subclass cannot be smuggled in without an unsafe assertion at
 * the call site (which would now be a single, very visible review red flag
 * rather than an invisible adapter implementation detail).
 *
 * ## Adapter contract
 *
 * Adapters MUST extend this class with their own subclass that carries
 * whatever per-claim bookkeeping they need (lease token, generation
 * counter, etc.). At `markProcessed` time the adapter SHOULD verify the
 * handle is one of its own subclass instances (e.g. via `instanceof`) and
 * raise a clear error otherwise — that turns a "wrong-adapter handle"
 * mistake into a deterministic failure at the boundary instead of a
 * mysterious silent no-op.
 *
 * Callers (the relay worker) MUST treat the value as opaque: pass it back
 * to `markProcessed` verbatim and never read fields off it.
 */
declare const outboxClaimHandleBrand: unique symbol;

export abstract class OutboxClaimHandle {
  // The `unique symbol` keyed property — declared but never assigned at
  // runtime — gives `OutboxClaimHandle` nominal typing under TypeScript's
  // otherwise structural type system. A plain object lacking this exact
  // symbol key cannot be assigned to `OutboxClaimHandle`, so the only way
  // a value can satisfy the type is via `extends OutboxClaimHandle`.
  // `declare` avoids `noUnusedLocals` on the private-field alternative
  // and emits no JS — the brand is purely a compile-time tag.
  declare readonly [outboxClaimHandleBrand]: true;
}

/**
 * Result of a successful claim.
 *
 * The batch's `entries` are decoded (well, re-read at least) for dispatch,
 * and `handle` is the opaque token that must accompany the subsequent
 * `markProcessed` call to scope that update to this worker's claim.
 */
export type OutboxClaimBatch = Readonly<{
  entries: readonly ClaimedOutboxEntry[];
  handle: OutboxClaimHandle;
}>;

/**
 * Writer surface used by application services that need to enqueue events
 * as part of their own DB work. Kept single-method so usecases get exactly
 * the capability they need and no read/claim access.
 *
 * Implementations MUST participate in the transactional executor that their
 * owning unit of work provides, so that `saveEvents` runs in the same
 * transaction as the entity changes that produced those events.
 *
 * ## Consumer idempotency (at-least-once delivery)
 *
 * Events written through this surface are delivered at-least-once downstream
 * by the relay worker. Consumers MUST be idempotent — typically by keying
 * their side effects on `event.id`. A crash between dispatch and
 * `markProcessed` causes redelivery once the lease expires.
 */
export interface OutboxWriter {
  /**
   * Persist the given domain events to the outbox. Must be invoked inside the
   * same transaction that produced the events.
   */
  saveEvents(events: readonly DomainEvent[]): Promise<void>;
}

/**
 * Read-only outbox surface.
 *
 * Intentionally narrow — there is no public `findAll()` because a
 * non-claiming read would let concurrent workers double-dispatch. Tests that
 * need to inspect pending rows should query the outbox table directly.
 * This exists primarily so worker-side repositories can extend it cleanly
 * when further read capabilities (e.g. metrics snapshots) are added.
 */
// biome-ignore lint/suspicious/noEmptyInterface: Kept as an extension point.
export interface OutboxReader {}

/**
 * Worker-only port used by the event relay worker.
 *
 * ## Consumer idempotency (at-least-once delivery)
 *
 * Delivery is at-least-once. Consumers of claimed events MUST be idempotent
 * (typically keyed on `event.id`). Crashes between dispatch and
 * `markProcessed` are the canonical source of redelivery.
 */
export interface OutboxWorkerRepository extends OutboxReader {
  /**
   * Atomically claim up to `batchSize` unprocessed entries whose existing
   * lease has expired (or which have never been claimed). Safe to call from
   * concurrent workers — each row is claimed by exactly one caller for the
   * duration of `leaseDurationMs`.
   *
   * Returns the claimed entries plus an opaque {@link OutboxClaimHandle}
   * that must be passed back to `markProcessed` so the "processed" update
   * can be scoped to this worker's claim.
   *
   * If dispatch fails or the worker crashes, the lease will expire and
   * another worker can re-claim the entry. This is at-least-once delivery.
   */
  claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<OutboxClaimBatch>;

  /**
   * Mark the given entry ids as processed. The update is scoped to the
   * `handle` returned by the original `claimPending` call, so an entry
   * whose lease expired and was re-claimed by another worker is left
   * untouched. `ids` may be a subset of the originally claimed entries
   * (e.g. when partial dispatches failed and are being retried later).
   */
  markProcessed(
    handle: OutboxClaimHandle,
    ids: readonly string[],
  ): Promise<void>;
}
