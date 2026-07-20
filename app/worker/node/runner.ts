import {
  type ConsumerHandler,
  createInMemoryQueueDispatcher,
} from "@repo/core/adapters/node/inMemoryQueueDispatcher";
import {
  createInProcessRelayTrigger,
  type InProcessRelayTrigger,
} from "@repo/core/adapters/node/inProcessRelayTrigger";
import type { WorkerContainer } from "@repo/core/application/di/types";
import type { Logger } from "@repo/core/application/ports/logger";
import type { RelayTrigger } from "@repo/core/application/ports/relayTrigger";
import {
  type EventDispatcher,
  type ProcessOutboxEventsOptions,
  processOutboxEvents,
} from "@repo/core/application/workers/eventRelayWorker";
import {
  DEFAULT_OUTBOX_RETENTION_MS,
  pruneOutbox,
} from "@repo/core/application/workers/outboxPrune";
import type { DomainEvent } from "@repo/core/domain/common/event";

export type NodeWorkerRunnerTuning = Readonly<{
  relayIntervalMs?: number;
  pruneIntervalMs?: number;
  outboxRetentionMs?: number;
  relayOptions?: ProcessOutboxEventsOptions;
  consumerConcurrency?: number;
}>;

export type NodeWorkerRunnerDeps = Readonly<{
  container: WorkerContainer;
  logger: Logger;
  consumerHandler: ConsumerHandler;
  cleanup?: () => Promise<void>;
  tuning?: NodeWorkerRunnerTuning;
}>;

export type NodeWorkerRunner = Readonly<{
  start(): void;
  stop(): Promise<void>;
  relayTrigger: RelayTrigger;
}>;

const DEFAULT_RELAY_INTERVAL_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Single-process orchestrator for the four CF workers (relay, consumer,
 * pruner, dlq). `start()` registers timers + signal handlers,
 * `relayTrigger.kick()` schedules an out-of-band relay tick collapsed
 * with concurrent kicks, `stop()` drains in-flight work and runs
 * `cleanup`. All three are idempotent.
 *
 * The "DLQ" role is satisfied by `processOutboxEvents`'s existing
 * `[outbox] quarantining event …` log line when `failed_at` is stamped;
 * a dedicated table / sweep is intentionally out of scope.
 */
export function createNodeWorkerRunner(
  deps: NodeWorkerRunnerDeps,
): NodeWorkerRunner {
  const { container, logger, consumerHandler: handler } = deps;
  const tuning = deps.tuning ?? {};

  const relayIntervalMs = tuning.relayIntervalMs ?? DEFAULT_RELAY_INTERVAL_MS;
  const pruneIntervalMs = tuning.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const outboxRetentionMs =
    tuning.outboxRetentionMs ?? DEFAULT_OUTBOX_RETENTION_MS;

  const consumerDispatch: EventDispatcher = createInMemoryQueueDispatcher({
    handler: async (event: DomainEvent) => {
      // Idempotency check before the handler keeps consumers from
      // double-firing on redelivery.
      const { alreadyProcessed } =
        await container.idempotencyStore.markProcessed(event.id);
      if (alreadyProcessed) {
        container.logger.info(
          `[queue] skipping redelivery of ${event.type} ${event.id}`,
          { eventId: event.id },
        );
        return;
      }
      container.logger.info(`[queue] received ${event.type} ${event.id}`, {
        event,
      });
      await handler(event);
    },
    ...(tuning.consumerConcurrency !== undefined
      ? { concurrency: tuning.consumerConcurrency }
      : {}),
  });

  const runRelayTick = async (): Promise<void> => {
    try {
      await processOutboxEvents(
        container,
        consumerDispatch,
        tuning.relayOptions ?? {},
      );
    } catch (cause) {
      logger.error("[runner.node] relay tick threw", { cause });
    }
  };

  const relayTrigger: InProcessRelayTrigger = createInProcessRelayTrigger({
    runTick: runRelayTick,
    logger,
  });

  const runPruneTick = async (): Promise<void> => {
    try {
      await pruneOutbox(container, { retentionMs: outboxRetentionMs });
    } catch (cause) {
      logger.error("[runner.node] prune tick threw", { cause });
    }
  };

  let started = false;
  let stopping: Promise<void> | null = null;

  let relayTimer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  // Tracked so `stop()` awaits every outstanding promise scheduled
  // outside the trigger.
  const pendingSweeps = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pendingSweeps.add(promise);
    promise.finally(() => {
      pendingSweeps.delete(promise);
    });
  };

  const signalHandler = (signal: NodeJS.Signals): void => {
    logger.info(`[runner.node] received ${signal}, shutting down`);
    void stop();
  };
  // Captured references so `process.off` can deregister the exact
  // listener we registered across start/stop cycles.
  const onSigterm = () => signalHandler("SIGTERM");
  const onSigint = () => signalHandler("SIGINT");

  const start = (): void => {
    if (started) return;
    started = true;

    // Drain crash-leftover backlog without waiting a full interval.
    track(runRelayTick());

    relayTimer = setInterval(() => {
      track(runRelayTick());
    }, relayIntervalMs);
    pruneTimer = setInterval(() => {
      track(runPruneTick());
    }, pruneIntervalMs);

    // Let the event loop exit naturally in tests / scripts; production
    // holds the loop open via the HTTP server.
    relayTimer.unref?.();
    pruneTimer.unref?.();

    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
  };

  const stop = async (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (relayTimer !== null) {
        clearInterval(relayTimer);
        relayTimer = null;
      }
      if (pruneTimer !== null) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);

      await relayTrigger.stop();
      // Snapshot via `Array.from` so concurrently-finishing entries that
      // mutate the Set don't disturb iteration.
      await Promise.all(Array.from(pendingSweeps));

      if (deps.cleanup !== undefined) {
        try {
          await deps.cleanup();
        } catch (cause) {
          logger.error("[runner.node] cleanup threw", { cause });
        }
      }
    })();
    return stopping;
  };

  return {
    start,
    stop,
    relayTrigger,
  };
}
