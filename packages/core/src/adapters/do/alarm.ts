import type { WorkerContainer } from "@repo/core/application/di/types";
import {
  type EventDispatcher,
  type ProcessOutboxEventsOptions,
  processOutboxEvents,
} from "@repo/core/application/workers/eventRelayWorker";
import { pruneOutbox } from "@repo/core/application/workers/outboxPrune";

export type OutboxAlarmDeps = Readonly<{
  container: WorkerContainer;
  dispatch: EventDispatcher;
  relayTuning: ProcessOutboxEventsOptions;
  retentionMs: number;
  /** `nextOutboxWakeUpAt` bound to the DO's SQLite + lease window. */
  nextWakeUpAt: () => Date | null;
  setAlarm: (at: Date) => Promise<void>;
}>;

/**
 * One alarm invocation of the DO-local outbox: relay → prune → re-arm.
 *
 * This replaces three pieces of the sibling-Worker topology at once —
 * the relay Worker, its safety-net cron, and the pruner Worker. The
 * platform guarantees alarm delivery and retries a throwing `alarm()`
 * handler with backoff, so no external cron is needed: the invariant is
 * that the alarm is armed whenever a pending outbox row exists (commit
 * arms it on insert; this tick re-arms while any row remains).
 *
 * Pruning here is a cheap indexed DELETE that usually matches nothing,
 * so it runs on every tick instead of a separate daily schedule.
 *
 * The re-arm time is clamped at least one second into the future: a
 * crash-recovered claim can be already-lapsed at compute time, and
 * arming in the past would fire the alarm again immediately — the
 * clamp turns that into a paced retry instead of a hot loop.
 */
export async function runOutboxAlarmTick(
  deps: OutboxAlarmDeps,
): Promise<{ processed: number; deleted: number }> {
  const { processed } = await processOutboxEvents(
    deps.container,
    deps.dispatch,
    deps.relayTuning,
  );
  const { deleted } = await pruneOutbox(deps.container, {
    retentionMs: deps.retentionMs,
  });
  const wake = deps.nextWakeUpAt();
  if (wake !== null) {
    const floor = deps.container.clock.now().getTime() + 1_000;
    await deps.setAlarm(new Date(Math.max(wake.getTime(), floor)));
  }
  return { processed, deleted };
}
