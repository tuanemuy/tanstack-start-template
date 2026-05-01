import type { Container } from "../di/server";

/**
 * Delete processed outbox rows older than `clock.now() - retentionMs`.
 * Schedule on a cron / queue runner sized to your retention policy. Safe
 * to run concurrently with the relay worker — a row only becomes a prune
 * candidate after `markProcessed` has stamped it.
 */
export type PruneOutboxOptions = {
  /** Retention window in milliseconds. Caller composes `days * 86_400_000` etc. */
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
