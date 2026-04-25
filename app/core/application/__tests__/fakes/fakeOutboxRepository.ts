import type { DomainEvent } from "@/core/domain/common/event";
import type {
  OutboxEntry,
  OutboxRepository,
} from "@/core/domain/common/ports/outboxRepository";

export type FakeOutboxRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
  processedAt: Date | null;
};

/**
 * In-memory `OutboxRepository` for application-layer / worker tests.
 *
 * The rows array is shared with the unit-of-work fake so events emitted
 * through `collectEvents` show up here for the worker side. Tests that need
 * to seed pending entries directly can push into `rows` without going
 * through a usecase.
 */
export class FakeOutboxRepository implements OutboxRepository {
  constructor(readonly rows: FakeOutboxRow[]) {}

  async save(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.rows.push({
        id: event.id,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
        aggregateId: event.aggregateId,
        processedAt: null,
      });
    }
  }

  async listPending(limit: number): Promise<readonly OutboxEntry[]> {
    return this.rows
      .filter((row) => row.processedAt === null)
      .sort((a, b) => {
        const t = a.occurredAt.getTime() - b.occurredAt.getTime();
        return t !== 0 ? t : a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        type: row.type,
        payload: row.payload,
        occurredAt: row.occurredAt,
        aggregateId: row.aggregateId,
      }));
  }

  async markProcessed(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const row of this.rows) {
      if (idSet.has(row.id) && row.processedAt === null) {
        row.processedAt = now;
      }
    }
  }
}
