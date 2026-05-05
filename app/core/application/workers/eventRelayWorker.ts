import {
  type DomainEvent,
  type EventDecoder,
  EventId,
} from "@/core/domain/common/event";
import type { TodoEvent } from "@/core/domain/todo/events";
import type { Container } from "../di/server";
import type { OutboxEntry, OutboxFailure } from "../ports/outboxRepository";
import { todoEventDecoders } from "../todo/eventDecoders";

// Delivery is at-least-once with NO ordering guarantee. Per-row failures
// bump `attempts` and schedule a backed-off retry; once a row exceeds
// `maxAttempts` it is quarantined (`failed_at` set) so a poison row stops
// blocking the hot path. Quarantined rows stay in the table for operator
// inspection — re-kick them by clearing `failed_at` / `next_attempt_at`.
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
  maxAttempts?: number;
  // Returns the delay (ms) before the next retry given the failure count
  // (1-based: `attempts` after the increment). Capped internally to keep
  // the next-attempt timestamp finite.
  backoffMs?: (attempts: number) => number;
};

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h ceiling

const defaultBackoffMs = (attempts: number): number =>
  Math.min(2 ** Math.max(attempts - 1, 0) * 30_000, MAX_BACKOFF_MS);

function decodeEntry(
  entry: OutboxEntry,
  registry: EventDecoderRegistry,
): DomainEvent {
  const decoder = registry[entry.type];
  if (!decoder) {
    throw new Error(`No decoder registered for event type "${entry.type}"`);
  }
  return decoder(entry.payload, {
    id: EventId.create(entry.id),
    occurredAt: entry.occurredAt,
    aggregateId: entry.aggregateId,
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const registry = options.decoderRegistry ?? defaultEventDecoderRegistry;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const { logger, clock, outboxRepository } = container;

  const now = clock.now();
  const entries = await outboxRepository.listPending(batchSize, now);
  if (entries.length === 0) return { processed: 0 };

  const failures: OutboxFailure[] = [];

  const planFailure = (entry: OutboxEntry, error: unknown): OutboxFailure => {
    const nextAttempts = entry.attempts + 1;
    const message = describeError(error);
    if (nextAttempts >= maxAttempts) {
      logger.error(
        `[outbox] quarantining event ${entry.id} (${entry.type}) after ${nextAttempts} attempts`,
        {
          eventId: entry.id,
          eventType: entry.type,
          attempts: nextAttempts,
          cause: error,
        },
      );
      return { id: entry.id, error: message, nextAttemptAt: null };
    }
    const delay = backoffMs(nextAttempts);
    return {
      id: entry.id,
      error: message,
      nextAttemptAt: new Date(now.getTime() + delay),
    };
  };

  type DecodedRow = { id: EventId; entry: OutboxEntry; event: DomainEvent };
  type DispatchOutcome =
    | { readonly kind: "success"; readonly id: EventId }
    | {
        readonly kind: "failure";
        readonly row: DecodedRow;
        readonly error: unknown;
      };

  const decoded: DecodedRow[] = [];
  for (const entry of entries) {
    try {
      const event = decodeEntry(entry, registry);
      decoded.push({ id: event.id, entry, event });
    } catch (error) {
      logger.error(
        `[outbox] decode failed for event ${entry.id} (${entry.type})`,
        { eventId: entry.id, eventType: entry.type, cause: error },
      );
      failures.push(planFailure(entry, error));
    }
  }

  const outcomes: DispatchOutcome[] =
    decoded.length === 0
      ? []
      : (
          await Promise.allSettled(decoded.map((row) => dispatch(row.event)))
        ).flatMap((result, index): DispatchOutcome[] => {
          const row = decoded[index];
          if (!row) return [];
          return [
            result.status === "fulfilled"
              ? { kind: "success", id: row.id }
              : { kind: "failure", row, error: result.reason },
          ];
        });

  const dispatchedIds: EventId[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "success") {
      dispatchedIds.push(outcome.id);
      continue;
    }
    logger.error(
      `[outbox] dispatch failed for event ${outcome.row.event.id} (${outcome.row.event.type})`,
      {
        eventId: outcome.row.event.id,
        eventType: outcome.row.event.type,
        cause: outcome.error,
      },
    );
    failures.push(planFailure(outcome.row.entry, outcome.error));
  }

  if (failures.length > 0) {
    await outboxRepository.markFailed(failures, now);
  }

  if (dispatchedIds.length === 0) return { processed: 0 };

  await outboxRepository.markProcessed(dispatchedIds, now);
  return { processed: dispatchedIds.length };
}
