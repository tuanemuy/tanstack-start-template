import type { DomainEvent } from "@/core/domain/common/event";
import type { OutboxWriter } from "@/core/domain/common/ports/outboxRepository";

/**
 * In-memory `OutboxWriter` implementation.
 *
 * Unlike the production adapter this fake only appends events to an in-memory
 * log — there is no queryable "outbox table". Use `getRecordedEvents()` from
 * a test to assert on what the usecase dropped into the outbox.
 *
 * Shared mutable state: the array is handed in from the unit-of-work fake so
 * a writer instance built for a "transaction" appends into the same log that
 * downstream test assertions read from.
 */
export class FakeOutboxWriter implements OutboxWriter {
  constructor(private readonly events: DomainEvent[]) {}

  async saveEvents(events: readonly DomainEvent[]): Promise<void> {
    // Push in call order so the `ReadWriteContext.collectEvents` ordering
    // invariant (documented on `ReadWriteContext`) holds for fakes too.
    this.events.push(...events);
  }
}
