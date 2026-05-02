import {
  type DomainEvent,
  type EventDecoder,
  EventId,
} from "@/core/domain/common/event";
import { type TodoEvent, todoEventDecoders } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import type { OutboxEntry } from "../ports/outboxRepository";

// Delivery is at-least-once with NO ordering guarantee. Per-row failures
// are logged and skipped (left pending) so a poison row will retry every
// tick — production deployments should layer DLQ + retry caps on top.
// Consumers must be idempotent keyed on `event.id`.
export type EventDispatcher = (event: DomainEvent) => Promise<void>;

export type EventDecoderRegistry = Readonly<
  Record<string, EventDecoder<DomainEvent>>
>;

type AllDomainEvents = TodoEvent;

type DefaultEventDecoderRegistry = {
  readonly [K in AllDomainEvents["type"]]: EventDecoder<
    Extract<AllDomainEvents, { type: K }>
  >;
};

export const defaultEventDecoderRegistry = {
  ...todoEventDecoders,
} satisfies DefaultEventDecoderRegistry;

export type ProcessOutboxEventsOptions = {
  batchSize?: number;
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
    id: EventId.create(entry.id),
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

  type DecodedRow = { id: EventId; event: DomainEvent };
  const decoded: DecodedRow[] = [];
  for (const entry of entries) {
    try {
      const event = decodeEntry(entry, registry);
      decoded.push({ id: event.id, event });
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
  const dispatchedIds: EventId[] = [];
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
