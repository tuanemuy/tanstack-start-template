import type { DomainEvent } from "@/core/domain/common/event";
import type { OutboxRepository } from "@/core/domain/common/ports/outboxRepository";
import type {
  TodoReader,
  TodoRepository,
} from "@/core/domain/todo/ports/todoRepository";

/**
 * Repositories visible inside a readonly unit of work.
 *
 * Each entry is typed with the `*Reader` subset of its domain port so that
 * calling `save` / `delete` / `saveEvents` is a compile-time error in
 * `{ mode: "readonly" }` usecases — no runtime traps needed.
 *
 * Outbox access is deliberately NOT exposed here: ordinary reads have no
 * reason to see the relay queue, and the worker-only surface belongs to
 * {@link WorkerContext}.
 */
export type ReadonlyContext = Readonly<{
  todoRepository: TodoReader;
}>;

/**
 * Repositories visible inside a read/write unit of work, plus `collectEvents`
 * for publishing domain events atomically via the outbox pattern.
 *
 * Events handed to `collectEvents` are persisted to the outbox in the same
 * transaction once the callback resolves. The raw {@link OutboxRepository}
 * is intentionally NOT exposed here — usecases must go through
 * `collectEvents` so that events always flow through the single write path
 * (no double-emission, no skipping of the outbox).
 *
 * Takes an array so domain operations that already return `readonly Event[]`
 * (via `WithEvents.events` or terminal operations like `Todo.delete`) can be
 * piped through in a single call.
 *
 * Worker-only operations (`claimPending` / `markProcessed`) live on
 * {@link WorkerContext} and are unreachable from regular usecases at the
 * type level.
 */
export type ReadWriteContext = Readonly<{
  todoRepository: TodoRepository;
  collectEvents: (events: readonly DomainEvent[]) => void;
}>;

/**
 * Context handed to outbox-relay workers. Exposes the full
 * {@link OutboxRepository} (claim / markProcessed / saveEvents) and nothing
 * else — domain repositories are intentionally absent so workers cannot mix
 * event relay with entity mutation.
 *
 * Opened exclusively through {@link UnitOfWorkProvider.runWorker} so that
 * ordinary usecases (which go through `run`) can never reach these
 * operations, even accidentally.
 */
export type WorkerContext = Readonly<{
  outboxRepository: OutboxRepository;
}>;

export type RunOptions = { mode?: "readonly" | "readwrite" };

export interface UnitOfWorkProvider {
  /**
   * Execute a callback within a single database transaction with write access
   * and event collection. This is the default mode.
   */
  run<T>(
    fn: (ctx: ReadWriteContext) => Promise<T>,
    options?: { mode?: "readwrite" },
  ): Promise<T>;

  /**
   * Execute a callback within a single database transaction with read-only
   * access to repositories.
   */
  run<T>(
    fn: (ctx: ReadonlyContext) => Promise<T>,
    options: { mode: "readonly" },
  ): Promise<T>;

  /**
   * Execute a callback within a single database transaction against the
   * outbox-only surface. Reserved for the event relay worker (claim +
   * dispatch + mark-processed). Ordinary application services MUST NOT use
   * this — they emit events via `collectEvents` on {@link ReadWriteContext}
   * instead.
   */
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T>;
}
