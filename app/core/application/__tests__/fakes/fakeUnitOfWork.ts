import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Todo } from "@/core/domain/todo/entity";
import type { TodoId } from "@/core/domain/todo/valueObject";
import {
  FakeOutboxRepository,
  type FakeOutboxRow,
} from "./fakeOutboxRepository";
import { FakeTodoRepository } from "./fakeTodoRepository";

/**
 * In-memory `UnitOfWorkProvider` for application-layer unit tests.
 *
 * Trade-offs vs. production:
 *
 * - **No transactions.** If the callback throws, repository writes and
 *   collected events made before the throw remain visible. Tests that need
 *   atomic rollback semantics should use the Drizzle-backed test container.
 * - **Shared store.** All repositories created by this provider share the
 *   same `Map` / `Array` instances, so a write in one `run` call is
 *   observable in the next.
 */
export class FakeUnitOfWorkProvider implements UnitOfWorkProvider {
  readonly todoStore: Map<TodoId, Todo>;
  readonly collectedEvents: DomainEvent[];
  readonly outboxRows: FakeOutboxRow[];

  constructor() {
    this.todoStore = new Map();
    this.collectedEvents = [];
    this.outboxRows = [];
  }

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const txEvents: DomainEvent[] = [];
    const ctx: UnitOfWorkContext = {
      todoRepository: new FakeTodoRepository(this.todoStore),
      collectEvents: (events) => {
        txEvents.push(...events);
      },
    };
    const result = await fn(ctx);
    if (txEvents.length > 0) {
      this.collectedEvents.push(...txEvents);
      await new FakeOutboxRepository(this.outboxRows).save(txEvents);
    }
    return result;
  }

  /** Test helper: snapshot of events flushed through `collectEvents`. */
  getRecordedEvents(): readonly DomainEvent[] {
    return [...this.collectedEvents];
  }
}
