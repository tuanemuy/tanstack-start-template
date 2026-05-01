import type { DomainEvent, EventDecoder } from "@/core/domain/common/event";
import { type TodoEvent, todoEventDecoders } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import type { OutboxEntry } from "../ports/outboxRepository";

/**
 * Drains the outbox: poll → decode → dispatch → mark processed. Per-row
 * decode/dispatch failures are logged and skipped (NOT marked processed)
 * so a future run can retry — delivery is therefore at-least-once but
 * best-effort: there is no dead-letter queue, no backoff cap, and a poison
 * row (e.g. a payload that no decoder can ever decode) will retry every
 * tick. Production deployments should layer DLQ + retry caps on top.
 *
 * `Promise.allSettled` over dispatch keeps one failing consumer from
 * knocking the rest off the train.
 */
export type EventDispatcher = (event: DomainEvent) => Promise<void>;

/**
 * Public registry type used by callers passing a custom registry. Wide on
 * purpose: a test fixture or alternate worker should be free to register
 * arbitrary keys.
 */
export type EventDecoderRegistry = Readonly<
  Record<string, EventDecoder<DomainEvent>>
>;

/**
 * Union of every domain's event type. Adding a new domain here makes the
 * coverage check below fail to typecheck until decoders are registered
 * for every new variant.
 */
type AllDomainEvents = TodoEvent;

type DefaultEventDecoderRegistry = {
  readonly [K in AllDomainEvents["type"]]: EventDecoder<
    Extract<AllDomainEvents, { type: K }>
  >;
};

const _coverage: DefaultEventDecoderRegistry = todoEventDecoders;

export const defaultEventDecoderRegistry: EventDecoderRegistry = {
  ..._coverage,
};

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
