import type { EventId } from "@repo/core/domain/common/event";

/**
 * Atomic claim keyed on `event.id`. Concurrent callers on the same id
 * observe exactly one `alreadyProcessed: false`.
 */
export interface IdempotencyStore {
  markProcessed(id: EventId): Promise<{ alreadyProcessed: boolean }>;
}
