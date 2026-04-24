import type {
  ReadonlyContext,
  ReadWriteContext,
  UnitOfWorkProvider,
  WorkerContext,
} from "@/core/application/execution/unitOfWork";
import type { DomainEvent } from "@/core/domain/common/event";
import type { Todo } from "@/core/domain/todo/entity";
import type { TodoId } from "@/core/domain/todo/valueObject";
import {
  type FakeOutboxRow,
  FakeOutboxWorkerRepository,
} from "./fakeOutboxWorkerRepository";
import { FakeOutboxWriter } from "./fakeOutboxWriter";
import { FakeTodoRepository } from "./fakeTodoRepository";

/**
 * In-memory `UnitOfWorkProvider` for application-layer unit tests.
 *
 * ## Deliberately simplified vs. production
 *
 * - **No transactions.** Each `run*` call simply invokes the callback and
 *   flushes `collectEvents` output on the happy path. If the callback
 *   throws, repository writes and collected events made before the throw
 *   remain visible to later calls. Tests that need atomic rollback-on-error
 *   semantics should use the Drizzle-backed `setupTestContainer` harness.
 * - **No retries.** We do not wrap in `RetryingUnitOfWorkProvider`; there
 *   is no transient error class to simulate in memory.
 * - **Shared store.** All repositories created by this provider share the
 *   same `Map` / `Array` instances, so a write made in one `run` call is
 *   observable in the next.
 *
 * These trade-offs make the fake fast and deterministic for usecase logic
 * tests; concurrency and adapter-specific behaviour belong in integration
 * tests.
 */
export class FakeUnitOfWorkProvider implements UnitOfWorkProvider {
  /** Backing todo aggregate store, keyed by TodoId. */
  readonly todoStore: Map<TodoId, Todo>;
  /**
   * Ordered log of events written through `collectEvents` plus any direct
   * writes through the worker's outbox rows. Usecase tests read from this
   * to assert on event emission without querying a DB.
   */
  readonly collectedEvents: DomainEvent[];
  /**
   * Worker-facing outbox rows. Populated lazily on first `runReadWrite`
   * commit so that tests that only invoke read/write usecases never have
   * to reason about worker plumbing.
   */
  readonly outboxRows: FakeOutboxRow[];

  constructor() {
    this.todoStore = new Map();
    this.collectedEvents = [];
    this.outboxRows = [];
  }

  async runReadonly<T>(fn: (ctx: ReadonlyContext) => Promise<T>): Promise<T> {
    // Intentionally hands out the same in-memory repo as the read/write
    // path — `ReadonlyContext` exposes only the `*Reader` subset at the
    // type level, so tests that ask for readonly still cannot call
    // `save` / `delete` through this fake even though the underlying
    // instance is a full repository.
    const ctx: ReadonlyContext = {
      todoRepository: new FakeTodoRepository(this.todoStore),
    };
    return fn(ctx);
  }

  async runReadWrite<T>(fn: (ctx: ReadWriteContext) => Promise<T>): Promise<T> {
    // Collect into a transaction-local buffer, then flush into the shared
    // log on the happy path — mirrors the real adapter's "collected ->
    // outbox on commit" ordering without needing a real transaction.
    const txEvents: DomainEvent[] = [];
    const ctx: ReadWriteContext = {
      todoRepository: new FakeTodoRepository(this.todoStore),
      collectEvents: (events) => {
        txEvents.push(...events);
      },
    };
    const result = await fn(ctx);
    if (txEvents.length > 0) {
      // Drain into both the flat log (for test assertions) and the
      // worker's outbox rows (for worker tests that want to exercise
      // claim/markProcessed against fake-written events).
      await new FakeOutboxWriter(this.collectedEvents).saveEvents(txEvents);
      for (const event of txEvents) {
        this.outboxRows.push({
          id: event.id,
          sequence: this.outboxRows.length + 1,
          event,
          schemaVersion: event.schemaVersion,
          processedAt: null,
          leaseToken: null,
          leasedUntil: null,
          occurredAt: event.occurredAt,
        });
      }
    }
    return result;
  }

  async runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T> {
    // `workerContextMarker` is a phantom symbol with no runtime shape —
    // cast through `unknown` as the production adapter does.
    const ctx = {
      outboxRepository: new FakeOutboxWorkerRepository(this.outboxRows),
    } as unknown as WorkerContext;
    return fn(ctx);
  }

  /**
   * Test helper: retrieve the events that have been flushed through
   * `collectEvents` so far. Returns a fresh array so consumers can splice
   * without affecting the underlying log.
   */
  getRecordedEvents(): readonly DomainEvent[] {
    return [...this.collectedEvents];
  }
}
