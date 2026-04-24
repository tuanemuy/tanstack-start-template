import type { DomainEvent } from "@/core/domain/common/event";
import type { OutboxWorkerRepository } from "@/core/domain/common/ports/outboxRepository";
import type {
  TodoReader,
  TodoRepository,
} from "@/core/domain/todo/ports/todoRepository";

/**
 * Repositories visible inside a readonly unit of work.
 *
 * Each entry is typed with the `*Reader` subset of its domain port so that
 * calling `save` / `delete` / `saveEvents` is a compile-time error in
 * readonly usecases — no runtime traps needed.
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
 * transaction once the callback resolves. The raw outbox writer is
 * intentionally NOT exposed here — usecases must go through `collectEvents`
 * so that events always flow through the single write path (no double-
 * emission, no skipping of the outbox).
 *
 * ## Ordering invariant
 *
 * `collectEvents` appends to an internal buffer in **call order**, and the
 * buffer is flushed to the outbox in that same push order. Downstream
 * consumers therefore observe events in the order the usecase emitted them
 * — this is a stable invariant: code that relies on a specific emission
 * order (e.g. `created` before `toggled` within one transaction) can do so
 * safely.
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
 * Phantom marker used to distinguish {@link WorkerContext} from the other
 * two context shapes at the type level. Purely structural — there is no
 * corresponding runtime property — but it makes `ReadWriteContext` and
 * `WorkerContext` mutually non-assignable, so domain repositories can
 * never be "added" to a worker context by a future refactor without the
 * intent being explicit at the type definition here.
 */
declare const workerContextMarker: unique symbol;

/**
 * Context handed to outbox-relay workers. Exposes only the
 * {@link OutboxWorkerRepository} (claim / markProcessed) plus a phantom
 * `__worker` tag — domain repositories are intentionally absent so workers
 * cannot mix event relay with entity mutation, and the tag makes that
 * separation structurally enforced rather than a convention.
 *
 * Opened exclusively through {@link UnitOfWorkProvider.runWorker} so that
 * ordinary usecases (which go through `runReadonly` / `runReadWrite`) can
 * never reach these operations, even accidentally.
 */
export type WorkerContext = Readonly<{
  outboxRepository: OutboxWorkerRepository;
  readonly [workerContextMarker]: true;
}>;

export interface UnitOfWorkProvider {
  /**
   * Execute a callback within a single database transaction with read-only
   * access to repositories. `save` / `delete` / `saveEvents` / `collectEvents`
   * are absent from `ReadonlyContext` at the type level, so side-effecting
   * calls inside this path are compile-time errors rather than runtime traps.
   */
  runReadonly<T>(fn: (ctx: ReadonlyContext) => Promise<T>): Promise<T>;

  /**
   * Execute a callback within a single database transaction with write access
   * and event collection. Events passed to `collectEvents` are flushed to the
   * outbox in the same transaction, preserving the caller's emission order.
   */
  runReadWrite<T>(fn: (ctx: ReadWriteContext) => Promise<T>): Promise<T>;

  /**
   * Execute a callback within a single database transaction against the
   * outbox-only surface. Reserved for the event relay worker (claim +
   * dispatch + mark-processed). Ordinary application services MUST NOT use
   * this — they emit events via `collectEvents` on {@link ReadWriteContext}
   * instead.
   */
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T>;
}
