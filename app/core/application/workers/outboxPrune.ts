import type { Container } from "../di/types";

export type PruneOutboxOptions = {
  retentionMs: number;
};

export async function pruneOutbox(
  container: Container,
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
