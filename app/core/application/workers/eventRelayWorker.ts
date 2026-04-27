import type { DomainEvent, EventDecoder } from "@/core/domain/common/event";
import { todoEventDecoders } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import type { OutboxEntry } from "../ports/outboxRepository";

/**
 * EventRelayWorker
 *
 * Drains the outbox by polling pending entries, decoding each through the
 * domain-owned decoder, dispatching to the caller-supplied callback, and
 * marking successfully dispatched rows as processed.
 *
 * Intended to be scheduled by an external runner (cron, queue worker, etc.).
 *
 * ## Delivery semantics: at-least-once
 *
 * If dispatch succeeds but `markProcessed` fails — or the worker crashes
 * between the two — the row stays pending and the next run dispatches it
 * again. **Consumers MUST be idempotent**, typically keyed on `event.id`.
 *
 * ## Partial-failure handling
 *
 * Per-row failures do not abort the batch:
 *
 * 1. **Decode failure** — corrupt row (unknown type, malformed payload).
 *    Logged and skipped (NOT marked processed) so a future run can retry
 *    once the bad row is fixed. Marking processed would silently lose data.
 * 2. **Dispatch failure** — consumer threw. Logged and skipped for this
 *    batch; the next run picks the row up again.
 *
 * `Promise.allSettled` over dispatch keeps one failing consumer from
 * knocking the rest off the train.
 */
export type EventDispatcher = (event: DomainEvent) => Promise<void>;

/**
 * Decoder registry keyed by the **full** `event.type` string (e.g.
 * `"todo.created"`, not just `"todo"`).
 *
 * ## Convention
 *
 * Each domain exports a per-domain map typed as
 * `Record<DomainEvent["type"], EventDecoder<DomainEvent>>` (e.g.
 * `todoEventDecoders` in `app/core/domain/todo/events.ts`). The worker
 * merges those maps into a single registry. Adding a new event variant to
 * a domain's union without registering its decoder is a compile-time
 * error rather than a runtime "no decoder registered" surprise.
 *
 * To add a new domain: export `<domain>EventDecoders` from that domain's
 * events file and spread it into {@link defaultEventDecoderRegistry}
 * below — that is the only edit the worker needs.
 */
export type EventDecoderRegistry = Readonly<
  Record<string, EventDecoder<DomainEvent>>
>;

/**
 * Default registry — merge of every domain's per-event decoder map.
 *
 * The spread is intentional: each domain's map is itself
 * compile-time-checked for exhaustiveness over its own union, and
 * spreading composes them without weakening that check on either side.
 */
export const defaultEventDecoderRegistry: EventDecoderRegistry = {
  ...todoEventDecoders,
};

export type ProcessOutboxEventsOptions = {
  /** Maximum number of entries to dispatch per invocation. Defaults to 100. */
  batchSize?: number;
  /**
   * Override the decoder registry for tests / specialised runners. Defaults
   * to {@link defaultEventDecoderRegistry}.
   */
  decoderRegistry?: EventDecoderRegistry;
};

const DEFAULT_BATCH_SIZE = 100;

function decodeEntry(
  entry: OutboxEntry,
  registry: EventDecoderRegistry,
): DomainEvent {
  const decoder = registry[entry.type];
  if (!decoder) {
    throw new Error(`No decoder registered for event type "${entry.type}"`);
  }
  return decoder(entry.type, entry.payload, {
    id: entry.id,
    occurredAt: entry.occurredAt,
    aggregateId: entry.aggregateId,
  });
}

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const registry = options.decoderRegistry ?? defaultEventDecoderRegistry;
  const { logger, clock, outboxRepository } = container;

  const entries = await outboxRepository.listPending(batchSize);
  if (entries.length === 0) return { processed: 0 };

  type DecodedRow = { id: string; event: DomainEvent };
  const decoded: DecodedRow[] = [];
  for (const entry of entries) {
    try {
      decoded.push({ id: entry.id, event: decodeEntry(entry, registry) });
    } catch (error) {
      logger.error(
        `[outbox] decode failed for event ${entry.id} (${entry.type})`,
        { eventId: entry.id, eventType: entry.type, cause: error },
      );
    }
  }

  if (decoded.length === 0) return { processed: 0 };

  const results = await Promise.allSettled(
    decoded.map((row) => dispatch(row.event)),
  );
  const dispatchedIds: string[] = [];
  results.forEach((result, index) => {
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

  if (dispatchedIds.length === 0) return { processed: 0 };

  await outboxRepository.markProcessed(dispatchedIds, clock.now());
  return { processed: dispatchedIds.length };
}
