import type { IdempotencyStore } from "@repo/core/application/ports/idempotencyStore";
import type { EventId } from "@repo/core/domain/common/event";
import { mapDoError } from "./helpers";
import type { TodoStateClient } from "./protocol";

/**
 * Consumer-Worker face of the DO-local `processed_events` table. The
 * atomic claim runs inside the DO (`DoSqliteIdempotencyStore`); this
 * class is only the RPC hop.
 */
export class DoIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly client: Pick<TodoStateClient, "markEventProcessed">,
  ) {}

  markProcessed(id: EventId): Promise<{ alreadyProcessed: boolean }> {
    return mapDoError("Failed to record processed event", () =>
      this.client.markEventProcessed(id),
    );
  }
}
