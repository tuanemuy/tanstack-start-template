import type { Clock } from "@repo/core/application/ports/clock";
import type { IdempotencyStore } from "@repo/core/application/ports/idempotencyStore";
import type { EventId } from "@repo/core/domain/common/event";
import type { Database } from "../client";
import { processedEvents } from "../schema";
import { mapDbError } from "./helpers";

// Atomicity comes from `INSERT ... ON CONFLICT DO NOTHING RETURNING` under
// SQLite's per-statement write lock — an empty RETURNING means we lost the
// race for `id`.
export class LibsqlIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async markProcessed(id: EventId): Promise<{ alreadyProcessed: boolean }> {
    return mapDbError("Failed to record processed event", async () => {
      const rows = await this.db
        .insert(processedEvents)
        .values({ id, processedAt: this.clock.now() })
        .onConflictDoNothing({ target: processedEvents.id })
        .returning({ id: processedEvents.id });
      return { alreadyProcessed: rows.length === 0 };
    });
  }
}
