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

type AllDomainEvents = TodoEvent;

export type DefaultEventDecoderRegistry = {
  readonly [K in AllDomainEvents["type"]]: EventDecoder<
    Extract<AllDomainEvents, { type: K }>
  >;
};

// Caller-supplied registries are scoped to the closed `AllDomainEvents` set
// so an unknown key (e.g. a typo or a stale event name) cannot slip past the
// type fence. Add a new event type to `AllDomainEvents` before registering
// its decoder.
export type EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>;

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
  // Identifies this worker on the rows it claims (diagnostics only).
  // Defaults to a fresh id from `container.idGenerator` per tick.
  workerId?: string;
  // How long a claimed row stays exclusive to this worker before another
  // worker is allowed to re-claim it (covers a crashed worker without an
  // explicit unclaim step). Should comfortably exceed the worst-case
  // dispatch latency of a single batch.
  leaseMs?: number;
  // Maximum number of in-flight `dispatch` calls within a single batch.
  // Caps fan-out to downstream consumers / external APIs.
  concurrency?: number;
};

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_CONCURRENCY = 8;
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h ceiling

const defaultBackoffMs = (attempts: number): number =>
  Math.min(2 ** Math.max(attempts - 1, 0) * 30_000, MAX_BACKOFF_MS);

function decodeEntry(
  entry: OutboxEntry,
  registry: EventDecoderRegistry,
): DomainEvent {
  // `entry.type` is `string` from the at-rest row; the typed registry is
  // keyed on `AllDomainEvents["type"]`. Cast at this single lookup point so
  // unknown row types fall through to the per-row failure path instead of
  // breaking the strict caller-facing type fence.
  const decoder = (
    registry as Readonly<Record<string, EventDecoder<DomainEvent> | undefined>>
  )[entry.type];
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
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const { logger, clock, outboxRepository, idGenerator } = container;
  const workerId = options.workerId ?? idGenerator.next();

  const now = clock.now();
  const entries = await outboxRepository.claimPending({
    limit: batchSize,
    now,
    workerId,
    leaseMs,
  });
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

  const outcomes: DispatchOutcome[] = [];
  if (decoded.length > 0) {
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < decoded.length) {
        const index = cursor++;
        const row = decoded[index];
        if (!row) continue;
        try {
          await dispatch(row.event);
          outcomes.push({ kind: "success", id: row.id });
        } catch (error) {
          outcomes.push({ kind: "failure", row, error });
        }
      }
    };
    const workerCount = Math.min(concurrency, decoded.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  }

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
