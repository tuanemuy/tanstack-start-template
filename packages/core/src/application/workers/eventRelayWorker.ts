import {
  type DomainEvent,
  type EventDecoder,
  EventId,
} from "@repo/core/domain/common/event";
import type { TodoEvent } from "@repo/core/domain/todo/events";
import type { WorkerContainer } from "../di/types";
import type { OutboxEntry, OutboxFailure } from "../ports/outboxRepository";
import { todoEventDecoders } from "../todo/eventDecoders";

// Delivery is at-least-once with NO ordering guarantee. Per-row failures
// bump `attempts` and schedule a backed-off retry; once a row exceeds
// `maxAttempts` it is quarantined (`failed_at` set) so a poison row stops
// blocking the hot path. Quarantined rows stay in the table for operator
// inspection — re-kick them by clearing `failed_at` / `next_attempt_at`.
// Consumers must be idempotent keyed on `event.id`.
//
// The dispatcher receives the full decoded batch of a single relay tick
// and returns a per-event outcome. The batched contract lets a Cloudflare
// Queue producer collapse N `send()` subrequests into a single
// `sendBatch()` call (subrequest-budget friendly), while finer-grained
// dispatchers (HTTP webhook fan-out, in-process subscribers) can still
// report per-event failures so a single bad row does not poison the rest
// of the batch. All-or-nothing dispatchers report the same failure for
// every event when the underlying call rejects.
//
// Outcomes may be returned in any order; rows are matched by event id.
// A row whose id is missing from the returned outcomes is treated as a
// failure for safety, so claimed rows always reach a terminal disposition
// within the tick.
export type EventDispatchOutcome =
  | { readonly kind: "success"; readonly id: EventId }
  | {
      readonly kind: "failure";
      readonly id: EventId;
      readonly error: unknown;
    };

export type EventDispatcher = (
  events: readonly DomainEvent[],
) => Promise<readonly EventDispatchOutcome[]>;

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
  // Defaults to a stable id minted once per isolate, so a worker that
  // crashes mid-batch and restarts on the same isolate sees its own
  // prior claim in `claimed_by` rather than an unrelated UUID.
  workerId?: string;
  // How long a claimed row stays exclusive to this worker before another
  // worker is allowed to re-claim it (covers a crashed worker without an
  // explicit unclaim step). Should comfortably exceed the worst-case
  // dispatch latency of a single batch.
  leaseMs?: number;
  // Maximum number of consecutive batches to drain in a single call.
  // The loop terminates as soon as a batch yields zero successful
  // dispatches (no more ready rows, or every claimed row failed) or
  // this cap is reached. Set to 1 to preserve single-batch semantics.
  // The cap exists so a Service-Binding-triggered run cannot exceed
  // Workers CPU budgets when the outbox has a large backlog — the
  // safety-net cron picks up the rest on the next tick.
  maxIterations?: number;
};

// Stable diagnostic id for the relay worker. Evaluated once at module
// load (i.e. per isolate), so successive ticks on the same isolate
// share the same `claimed_by` value. UUIDv4 is sufficient — this id is
// never used as a domain key, only for log correlation and lease
// attribution.
const RELAY_WORKER_ID = crypto.randomUUID();

export const DEFAULT_BATCH_SIZE = 100;
// Quarantine after 2 publish attempts. The consumer-side queue then
// owns redelivery (`max_retries` in wrangler.toml [env.consumer]), so
// the total user-visible retry count is the product of the two — keep
// this low to avoid the multiplication producing surprising attempt
// counts.
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_MAX_ITERATIONS = 10;
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h ceiling

// Exponential backoff with a 30s base and a 1h cap. `attempts` is
// 1-based (the value after the increment in `planFailure`). Schedule:
//
//   attempts | delay
//   ---------|-------
//   1        | 30s
//   2        | 60s
//   3        | 2m
//   4        | 4m
//   5        | 8m
//   6        | 16m
//   7        | 32m
//   8+       | 1h (capped)
//
// With `DEFAULT_MAX_ATTEMPTS = 2`, only `attempts=1` actually fires;
// the table matters when callers raise `maxAttempts`.
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

// Cap the persisted `last_error` payload. Diagnostic-only column; the
// head is by far the most useful part, and an unbounded driver-thrown
// message (e.g. a SQL statement echoed back verbatim) would otherwise
// bloat the row indefinitely across retries.
const LAST_ERROR_MAX_LENGTH = 4096;
const LAST_ERROR_TRUNCATION_SUFFIX = "…(truncated)";

function describeError(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (raw.length <= LAST_ERROR_MAX_LENGTH) return raw;
  return (
    raw.slice(0, LAST_ERROR_MAX_LENGTH - LAST_ERROR_TRUNCATION_SUFFIX.length) +
    LAST_ERROR_TRUNCATION_SUFFIX
  );
}

export async function processOutboxEvents(
  container: WorkerContainer,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let total = 0;
  for (let i = 0; i < maxIterations; i++) {
    const { processed } = await processOutboxBatch(
      container,
      dispatch,
      options,
    );
    total += processed;
    // Stop on an empty success count: either the outbox is drained,
    // or every claimed row failed (in which case retrying immediately
    // would just re-claim the same rows). Backoff + cron handle that.
    if (processed === 0) break;
  }
  return { processed: total };
}

async function processOutboxBatch(
  container: WorkerContainer,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const registry = options.decoderRegistry ?? defaultEventDecoderRegistry;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const { logger, clock, outboxRepository } = container;
  const workerId = options.workerId ?? RELAY_WORKER_ID;

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

  type DecodedRow = {
    readonly id: EventId;
    readonly entry: OutboxEntry;
    readonly event: DomainEvent;
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

  const dispatchedIds: EventId[] = [];
  if (decoded.length > 0) {
    const events = decoded.map((row) => row.event);
    const rowsById = new Map(decoded.map((row) => [row.id, row] as const));
    let outcomes: readonly EventDispatchOutcome[];
    try {
      outcomes = await dispatch(events);
    } catch (error) {
      // Contract is "return outcomes, do not throw". A throwing dispatcher
      // is treated as a batch-wide failure so claimed rows still get their
      // attempts bumped and a retry scheduled.
      outcomes = decoded.map((row) => ({
        kind: "failure" as const,
        id: row.id,
        error,
      }));
    }

    const seen = new Set<EventId>();
    for (const outcome of outcomes) {
      const row = rowsById.get(outcome.id);
      if (!row) continue;
      seen.add(outcome.id);
      if (outcome.kind === "success") {
        dispatchedIds.push(outcome.id);
        continue;
      }
      logger.error(
        `[outbox] dispatch failed for event ${row.event.id} (${row.event.type})`,
        {
          eventId: row.event.id,
          eventType: row.event.type,
          cause: outcome.error,
        },
      );
      failures.push(planFailure(row.entry, outcome.error));
    }

    for (const row of decoded) {
      if (seen.has(row.id)) continue;
      const error = new Error(
        `dispatcher returned no outcome for event ${row.id}`,
      );
      logger.error(
        `[outbox] dispatcher returned no outcome for event ${row.event.id} (${row.event.type})`,
        { eventId: row.event.id, eventType: row.event.type },
      );
      failures.push(planFailure(row.entry, error));
    }
  }

  await outboxRepository.finalize({
    processed: dispatchedIds,
    failures,
    now,
  });
  return { processed: dispatchedIds.length };
}
