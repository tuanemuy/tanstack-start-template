import type { DomainEvent } from "@/core/domain/common/event";
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";

/**
 * Per-callback context passed into the UoW callback. Lists every domain
 * repository the callback can touch plus `collectEvents` for atomic outbox
 * publishing.
 *
 * Adding a new domain repository is a one-line edit here (and a wiring edit
 * in the adapter's `unitOfWork.ts`). At template scale that is cheaper and
 * more readable than declaration-merging from each domain's port file; the
 * usecase signatures (`async ({ todoRepository, collectEvents }) => …`) stay
 * the same either way.
 *
 * ## Ordering invariant
 *
 * `collectEvents` appends to an internal buffer in **call order**, and the
 * buffer is flushed to the outbox in that same order. Code that relies on a
 * specific emission order within one transaction (e.g. `created` before
 * `toggled`) can do so safely.
 */
export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  collectEvents(events: readonly DomainEvent[]): void;
}

export interface UnitOfWorkProvider {
  /**
   * Execute a callback within a single database transaction. Events handed
   * to `collectEvents` flush to the outbox in the same transaction, in call
   * order.
   */
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
