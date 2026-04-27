import type { Container } from "../di/server";

/**
 * Outbox prune worker.
 *
 * The outbox table retains rows with `processed_at IS NOT NULL` for
 * audit/debugging — left unattended it grows without bound. Schedule this
 * function on a cron / queue runner sized to your retention policy; the
 * relay worker (`processOutboxEvents`) and the prune worker share the same
 * `OutboxRepository` and are safe to run concurrently because a row only
 * becomes a prune candidate after `markProcessed` has stamped it.
 *
 * ## What this is NOT
 *
 * Not a backup, not a "soft delete" — pruned rows are gone. If you need
 * long-term audit history, copy rows out to a separate audit table before
 * `processed_at < cutoff` becomes true.
 */

export type PruneOutboxOptions = {
  /**
   * Retention window in milliseconds. Rows whose `processed_at` is strictly
   * older than `clock.now() - retentionMs` are deleted. Pending rows are
   * never touched.
   *
   * Caller computes this raw — milliseconds is the canonical unit. A
   * `{ days }` shorthand can live at the call site:
   * `pruneOutbox(c, { retentionMs: days * 86_400_000 })`.
   */
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
