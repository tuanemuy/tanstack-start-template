// Worker handler logic, factored out of any specific entrypoint so the
// three deployable Workers (relay producer, queue consumer, outbox
// pruner) can each export only the function they need.
//
// One Worker per responsibility was a deliberate choice over a single
// combined entry: it eliminates the `controller.cron === ...` string
// match that would otherwise be required to fan out a shared
// `scheduled` handler, isolates failures, and lets each Worker declare
// only the bindings it actually uses (the pruner needs no Queue, the
// consumer needs no D1 producer write path, etc.).
import type {
  ExecutionContext,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import {
  createContainer,
  readServerConfig,
  type ServerEnv,
} from "@/core/application/di/server";
import {
  type EventDispatcher,
  type ProcessOutboxEventsOptions,
  processOutboxEvents,
} from "@/core/application/workers/eventRelayWorker";
import {
  type PruneOutboxOptions,
  pruneOutbox,
} from "@/core/application/workers/outboxPrune";
import type { DomainEvent } from "@/core/domain/common/event";

/**
 * Bindings shared by the relay producer Worker — it reads from D1 and
 * publishes to the events queue.
 */
export type RelayEnv = ServerEnv &
  Readonly<{
    EVENTS_QUEUE: Queue<DomainEvent>;
  }>;

/**
 * Bindings for the outbox pruner Worker. It only needs D1; nothing
 * else is wired so the principle of least privilege is enforced at
 * the deployment manifest.
 */
export type PrunerEnv = ServerEnv;

/**
 * Bindings for the queue consumer Worker. D1 is included so subscribers
 * (read-model projections, idempotency stamps, etc.) can write through
 * the application container; remove if your consumers are stateless.
 */
export type ConsumerEnv = ServerEnv;

const PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Cron-driven outbox relay tick. Claims pending rows and dispatches
 * the whole decoded batch to the durable Queue in a single
 * `sendBatch()` call (one subrequest, not N). `sendBatch` is
 * all-or-nothing, so on rejection every event is reported as a failure
 * and `processOutboxEvents` schedules them for retry; on success every
 * event is reported success and the rows are marked processed.
 */
export async function runRelayTick(
  env: RelayEnv,
  options?: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const container = createContainer(readServerConfig(env));
  const dispatch: EventDispatcher = async (events) => {
    if (events.length === 0) return [];
    try {
      await env.EVENTS_QUEUE.sendBatch(events.map((body) => ({ body })));
      return events.map((event) => ({
        kind: "success" as const,
        id: event.id,
      }));
    } catch (error) {
      return events.map((event) => ({
        kind: "failure" as const,
        id: event.id,
        error,
      }));
    }
  };
  return processOutboxEvents(container, dispatch, options);
}

/**
 * Daily prune of long-since-processed outbox rows. Quarantined rows
 * (`failed_at IS NOT NULL`) are intentionally preserved so an operator
 * can inspect them.
 */
export async function runPruneTick(
  env: PrunerEnv,
  options: PruneOutboxOptions = { retentionMs: PRUNE_RETENTION_MS },
): Promise<{ deleted: number }> {
  const container = createContainer(readServerConfig(env));
  return pruneOutbox(container, options);
}

/**
 * Queue consumer. Per-message try/catch keeps a poison message from
 * taking down the rest of the batch — Cloudflare Queues retry the
 * `retry()`-ed messages with their own backoff and DLQ policy.
 *
 * The placeholder body logs each event; replace with real subscriber
 * wiring (read-model projection, external webhook, etc.). Idempotency
 * is the subscriber's responsibility, keyed on `event.id`.
 */
export async function handleQueue(
  batch: MessageBatch<DomainEvent>,
  env: ConsumerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createContainer(readServerConfig(env));
  for (const message of batch.messages) {
    try {
      container.logger.info(
        `[queue] received ${message.body.type} ${message.body.id}`,
        { event: message.body },
      );
      message.ack();
    } catch (error) {
      container.logger.error(
        `[queue] handler failed for ${message.body.type} ${message.body.id}`,
        { eventId: message.body.id, cause: error },
      );
      message.retry();
    }
  }
}
