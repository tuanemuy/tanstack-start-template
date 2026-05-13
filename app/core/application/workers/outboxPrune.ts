import type { WorkerContainer } from "../di/types";

// Retain processed outbox rows for one week before the daily pruner
// sweeps them. Quarantined rows (`failed_at IS NOT NULL`) are out of
// scope — they stay until an operator clears them.
export const DEFAULT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type PruneOutboxOptions = {
  retentionMs: number;
};

export async function pruneOutbox(
  container: WorkerContainer,
  options: PruneOutboxOptions,
): Promise<{ deleted: number }> {
  const { clock, logger, outboxRepository } = container;
  const cutoff = new Date(clock.now().getTime() - options.retentionMs);
  const { deleted } = await outboxRepository.pruneProcessed(cutoff);
  logger.info(`[outbox] pruned ${deleted} processed event(s)`, {
    deleted,
    retentionMs: options.retentionMs,
    cutoff: cutoff.toISOString(),
  });
  return { deleted };
}
