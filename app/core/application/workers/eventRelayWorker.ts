import type { DomainEvent } from "@/core/domain/common/event";
import { decodeTodoEvent } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import {
  createEventDecoderRegistry,
  type EventDecoderRegistry,
} from "../events/eventDispatch";

/**
 * EventRelayWorker
 *
 * Drains the outbox by atomically claiming a batch of pending entries,
 * decoding each entry's payload through the domain-owned decoder registry,
 * invoking a dispatch callback per decoded event, and marking the
 * successfully dispatched rows as processed — scoped to the claim handle
 * returned by the outbox adapter so a row that was re-claimed by another
 * worker after the lease expired is left for that worker to finish.
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
 *
 * ## Partial-failure handling
 *
 * Within a single batch we tolerate two kinds of per-row failures without
 * aborting the batch:
 *
 * 1. **Decode failure** — a corrupt row (unknown event type, malformed
 *    payload, unsupported schema version). The row is skipped, its
 *    failure logged through `container.logger.error` for observability,
 *    and the lease is left to expire so a future run can retry once the
 *    bad row is fixed. We do NOT `markProcessed` decode-failed rows,
 *    because that would silently lose data.
 *
 * 2. **Dispatch failure** — the consumer threw / rejected. The row is
 *    skipped for this batch, logged through `container.logger.error`, and
 *    its lease left to expire. Only rows whose dispatch resolved
 *    successfully are handed to `markProcessed`.
 *
 * `Promise.allSettled` over dispatch ensures one bad consumer call doesn't
 * knock the rest of the batch off the train: each row is accounted for
 * independently, successes clear, failures wait for lease expiry.
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
  const { logger, clock } = container;

  // Claim a batch under a fresh lease. Concurrent workers that race here
  // each receive a disjoint subset because `claimPending` atomically stamps
  // the rows it returns. The "now" used for lease bookkeeping comes from
  // the injected `Clock` so worker tests can fast-forward time deterministically.
  //
  // `runWorker` exposes the outbox-only context — ordinary `runReadWrite`
  // no longer has `outboxRepository` in scope, so worker concerns can't
  // leak into regular usecases at the type level.
  const claim = await container.unitOfWorkProvider.runWorker(
    ({ outboxRepository }) =>
      outboxRepository.claimPending(batchSize, leaseDurationMs, clock.now()),
  );

  if (claim.entries.length === 0) {
    return { processed: 0 };
  }

  // Decode pass: fold decode failures into a per-row skip list with an
  // observability signal. A single corrupt row MUST NOT abort the batch
  // — that would block every valid row behind an unfixable one until the
  // lease expires, and burn through the retry budget uselessly.
  type DecodedRow = { id: string; event: DomainEvent };
  const decoded: DecodedRow[] = [];
  for (const entry of claim.entries) {
    const result = registry.decode({
      type: entry.event.type,
      payload: entry.event.payload,
      meta: {
        id: entry.event.id,
        occurredAt: entry.event.occurredAt,
        schemaVersion: entry.schemaVersion,
        aggregateId: entry.event.aggregateId,
      },
    });
    if (result.ok) {
      decoded.push({ id: entry.id, event: result.event });
    } else {
      // Decode-failed rows are left un-marked-processed: their lease will
      // expire and a later run will re-attempt. Log through the injected
      // structured logger so production sinks can alert on this signal.
      logger.error(
        `[outbox] decode failed for event ${entry.event.id} (${entry.event.type})`,
        {
          eventId: entry.event.id,
          eventType: entry.event.type,
          cause: result.error,
        },
      );
    }
  }

  if (decoded.length === 0) {
    // Nothing to dispatch — every claimed row was corrupt. Returning 0
    // keeps the scheduler's "processed this tick" counter honest.
    return { processed: 0 };
  }

  // Dispatch happens OUTSIDE the worker transaction: a retryable failure
  // inside `runWorker` would re-run the whole callback, and we do not want
  // to replay HTTP/RPC side-effects on every retry. (See
  // `RetryingUnitOfWorkProvider` for the general rule.)
  //
  // `Promise.allSettled` so a single failing dispatch doesn't short-circuit
  // the batch: successful rows still get `markProcessed`, failures are
  // left for the next lease-expiry run to retry.
  const dispatchResults = await Promise.allSettled(
    decoded.map((row) => dispatch(row.event)),
  );
  const dispatchedIds: string[] = [];
  dispatchResults.forEach((result, index) => {
    const row = decoded[index];
    if (!row) return;
    if (result.status === "fulfilled") {
      dispatchedIds.push(row.id);
    } else {
      logger.error(
        `[outbox] dispatch failed for event ${row.event.id} (${row.event.type})`,
        {
          eventId: row.event.id,
          eventType: row.event.type,
          cause: result.reason,
        },
      );
    }
  });

  if (dispatchedIds.length === 0) {
    return { processed: 0 };
  }

  // One round-trip per batch. `markProcessed` is scoped to the claim
  // handle so entries whose lease expired and were re-claimed by another
  // worker are skipped here; the new claimant will mark them processed
  // when it's done.
  await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
    outboxRepository.markProcessed(claim.handle, dispatchedIds),
  );

  return { processed: dispatchedIds.length };
}
