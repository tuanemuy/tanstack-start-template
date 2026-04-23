import type { DomainEvent } from "@/core/domain/common/event";
import { decodeTodoEvent } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import {
  createEventDecoderRegistry,
  type EventDecoderRegistry,
} from "../eventDispatch";

/**
 * EventRelayWorker
 *
 * Drains the outbox by atomically claiming a batch of pending entries,
 * decoding each entry's payload through the domain-owned decoder registry,
 * invoking a dispatch callback per decoded event, and marking the
 * successfully dispatched rows as processed — scoped to the claiming lease
 * token so a row that was re-claimed by another worker after the lease
 * expired is left for that worker to finish.
 *
 * Intended to be scheduled by an external runner (cron, queue worker, etc.).
 * The dispatcher is passed in rather than resolved from the container so
 * that the container stays minimal until a concrete event-dispatching
 * adapter is introduced.
 *
 * ## Delivery semantics: at-least-once
 *
 * Entries are claimed with a time-boxed lease. If dispatch succeeds but
 * `markProcessed` fails — or the worker crashes between the two — the lease
 * eventually expires and another run re-claims the entries. A consumer that
 * already received the event will therefore see it a second time.
 *
 * **Consumers MUST be idempotent**, typically by keying their side effects
 * on `event.id`.
 */
export type EventDispatcher = (event: DomainEvent) => Promise<void>;

export type ProcessOutboxEventsOptions = {
  /**
   * Maximum number of entries to claim and dispatch per invocation.
   * Defaults to 100.
   */
  batchSize?: number;
  /**
   * How long the claim protects the batch from other workers, in
   * milliseconds. After this window elapses without the batch being marked
   * processed, another worker may re-claim the entries. Defaults to 30s.
   */
  leaseDurationMs?: number;
  /**
   * Registry used to decode raw wire payloads back into branded domain
   * events before dispatch. Defaults to {@link defaultEventDecoderRegistry}
   * which covers every domain currently wired in the application. Tests and
   * specialised runners can pass a narrower registry to isolate behaviour.
   */
  decoderRegistry?: EventDecoderRegistry;
};

/**
 * Shipped decoder registry: add a domain's decoder here when the domain
 * introduces events that flow through the outbox. Registration is explicit
 * (no dynamic imports) so `grep` surfaces every wired decoder.
 */
export const defaultEventDecoderRegistry = createEventDecoderRegistry({
  todo: decodeTodoEvent,
});

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_DURATION_MS = 30_000;

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const registry = options.decoderRegistry ?? defaultEventDecoderRegistry;

  // Claim a batch under a fresh lease. Concurrent workers that race here
  // each receive a disjoint subset because `claimPending` atomically stamps
  // the rows it returns.
  //
  // `runWorker` exposes the outbox-only context — ordinary `run` no longer
  // has `outboxRepository` in scope, so worker concerns can't leak into
  // regular usecases at the type level.
  const entries = await container.unitOfWorkProvider.runWorker(
    ({ outboxRepository }) =>
      outboxRepository.claimPending(batchSize, leaseDurationMs, new Date()),
  );

  if (entries.length === 0) {
    return { processed: 0 };
  }

  // Dispatch happens OUTSIDE the worker transaction: a retryable failure
  // inside `runWorker` would re-run the whole callback, and we do not want
  // to replay HTTP/RPC side-effects on every retry. (See
  // `RetryingUnitOfWorkProvider` for the general rule.)
  //
  // A decoder failure (unknown type, malformed payload, unsupported schema)
  // aborts the batch before any dispatch happens for that row; the lease
  // will expire and a later run can retry once the bad row is fixed.
  const dispatched: { id: string; leaseToken: string }[] = [];
  for (const entry of entries) {
    const decoded = registry.decode({
      type: entry.event.type,
      payload: entry.event.payload,
      meta: {
        id: entry.event.id,
        occurredAt: entry.event.occurredAt,
        schemaVersion: entry.schemaVersion,
        ...(entry.event.aggregateId !== undefined
          ? { aggregateId: entry.event.aggregateId }
          : {}),
      },
    });
    await dispatch(decoded);
    dispatched.push({ id: entry.id, leaseToken: entry.leaseToken });
  }

  // One round-trip per batch. `markProcessed` is scoped to the lease token
  // so entries whose lease expired and were re-claimed by another worker
  // are skipped here; the new claimant will mark them processed when it's
  // done.
  await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
    outboxRepository.markProcessed(dispatched),
  );

  return { processed: dispatched.length };
}
