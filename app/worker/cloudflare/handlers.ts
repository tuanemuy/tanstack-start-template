import type {
  ExecutionContext,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import {
  createWorkerContainer,
  readPruneTuning,
  readRelayTuning,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import {
  type EventDispatcher,
  type ProcessOutboxEventsOptions,
  processOutboxEvents,
} from "@repo/core/application/workers/eventRelayWorker";
import {
  type PruneOutboxOptions,
  pruneOutbox,
} from "@repo/core/application/workers/outboxPrune";
import type { DomainEvent } from "@repo/core/domain/common/event";

export type RelayEnv = ServerEnv &
  Readonly<{
    EVENTS_QUEUE: Queue<DomainEvent>;
  }>;

export type PrunerEnv = ServerEnv;

export type ConsumerEnv = ServerEnv;

export type DlqEnv = ServerEnv;

/**
 * `sendBatch` is all-or-nothing — on rejection every event is reported
 * as a failure so `processOutboxEvents` reschedules the whole batch
 * uniformly rather than splitting success/failure mid-flight.
 *
 * `override` lets tests / programmatic callers bypass the env-derived
 * tuning. In production both entry points (cron + Service Binding fetch)
 * pass nothing and the values come from `[env.relay.vars]`.
 */
export async function runRelayTick(
  env: RelayEnv,
  override?: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const container = createWorkerContainer(env);
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
  return processOutboxEvents(container, dispatch, {
    ...readRelayTuning(env),
    ...override,
  });
}

/**
 * Quarantined rows (`failed_at IS NOT NULL`) are intentionally
 * preserved for operator inspection.
 */
export async function runPruneTick(
  env: PrunerEnv,
  override?: Partial<PruneOutboxOptions>,
): Promise<{ deleted: number }> {
  const container = createWorkerContainer(env);
  return pruneOutbox(container, { ...readPruneTuning(env), ...override });
}

export async function handleQueue(
  batch: MessageBatch<DomainEvent>,
  env: ConsumerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createWorkerContainer(env);
  for (const message of batch.messages) {
    try {
      const { alreadyProcessed } =
        await container.idempotencyStore.markProcessed(message.body.id);
      if (alreadyProcessed) {
        container.logger.info(
          `[queue] skipping redelivery of ${message.body.type} ${message.body.id}`,
          { eventId: message.body.id },
        );
        message.ack();
        continue;
      }
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

/**
 * Always acks: the DLQ has no further dead-letter target, so a
 * re-failure would loop. Re-driving is a manual operator action once
 * the upstream cause is resolved.
 */
export async function handleDlq(
  batch: MessageBatch<DomainEvent>,
  env: DlqEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createWorkerContainer(env);
  for (const message of batch.messages) {
    container.logger.error(
      `[dlq] event quarantined after retries: ${message.body.type} ${message.body.id}`,
      {
        eventId: message.body.id,
        eventType: message.body.type,
        attempts: message.attempts,
        event: message.body,
      },
    );
    message.ack();
  }
}
