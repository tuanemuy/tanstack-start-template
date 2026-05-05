// Workers `scheduled` and `queue` handlers, isolated from the TanStack
// Start fetch pipeline so unit tests can drive them without booting
// the React/RSC server graph. The combined entry that exposes all three
// to wrangler lives in `app/worker.ts`.
import type {
  ExecutionContext,
  MessageBatch,
  Queue,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createD1Container,
  type D1Env,
  readD1ServerConfig,
} from "@/core/application/di/d1";
import {
  type EventDispatcher,
  processOutboxEvents,
  type ProcessOutboxEventsOptions,
} from "@/core/application/workers/eventRelayWorker";
import {
  pruneOutbox,
  type PruneOutboxOptions,
} from "@/core/application/workers/outboxPrune";
import type { DomainEvent } from "@/core/domain/common/event";

export type WorkerEnv = D1Env &
  Readonly<{
    EVENTS_QUEUE: Queue<DomainEvent>;
  }>;

export const RELAY_CRON = "*/1 * * * *"; // every minute
export const PRUNE_CRON = "0 3 * * *"; // 03:00 UTC daily
const PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Cron-driven outbox relay tick. Claims pending rows and dispatches
 * each event to the durable Queue; `processOutboxEvents` marks rows
 * processed iff the producer accepts the message.
 */
export async function runRelayTick(
  env: WorkerEnv,
  options?: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const container = createD1Container(readD1ServerConfig(env));
  const dispatch: EventDispatcher = async (event: DomainEvent) => {
    await env.EVENTS_QUEUE.send(event);
  };
  return processOutboxEvents(container, dispatch, options);
}

/**
 * Daily prune of long-since-processed outbox rows. Quarantined rows
 * (`failed_at IS NOT NULL`) are intentionally preserved so an operator
 * can inspect them.
 */
export async function runPruneTick(
  env: WorkerEnv,
  options: PruneOutboxOptions = { retentionMs: PRUNE_RETENTION_MS },
): Promise<{ deleted: number }> {
  const container = createD1Container(readD1ServerConfig(env));
  return pruneOutbox(container, options);
}

export async function handleScheduled(
  controller: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === RELAY_CRON) {
    ctx.waitUntil(runRelayTick(env));
    return;
  }
  if (controller.cron === PRUNE_CRON) {
    ctx.waitUntil(runPruneTick(env));
    return;
  }
  // Defensive: a cron expression that reaches here is one configured
  // in `wrangler.toml` but unhandled in code — surface it instead of
  // silently dropping the tick.
  const container = createD1Container(readD1ServerConfig(env));
  container.logger.warn(
    `[scheduled] no handler registered for cron ${controller.cron}`,
  );
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
  env: WorkerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createD1Container(readD1ServerConfig(env));
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
