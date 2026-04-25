import type { DomainEvent, EventDecoder } from "@/core/domain/common/event";
import type { OutboxEntry } from "@/core/domain/common/ports/outboxRepository";
import { decodeTodoEvent } from "@/core/domain/todo/events";
import type { Container } from "../di/server";

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
 * Maps an event-type prefix (the token before the first `.`, e.g. `"todo"`
 * for `"todo.created"`) to the decoder that owns that domain's events. Add
 * a new domain by registering its decoder here.
 */
export type EventDecoderRegistry = Readonly<Record<string, EventDecoder>>;

export const defaultEventDecoderRegistry: EventDecoderRegistry = {
  todo: decodeTodoEvent,
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
  const dot = entry.type.indexOf(".");
  const prefix = dot < 0 ? entry.type : entry.type.slice(0, dot);
  const decoder = registry[prefix];
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
