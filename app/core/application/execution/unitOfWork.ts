import type { DomainEvent } from "@/core/domain/common/event";
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";

/**
 * Repositories visible inside a unit of work, plus `collectEvents` for
 * publishing domain events atomically via the Outbox pattern.
 *
 * Events handed to `collectEvents` are persisted to the outbox in the same
 * transaction once the callback resolves. Usecases never reach the raw
 * outbox writer — `collectEvents` is the single write path so events always
 * commit atomically with the entity changes that produced them.
 *
 * ## Ordering invariant
 *
 * `collectEvents` appends to an internal buffer in **call order**, and the
 * buffer is flushed to the outbox in that same order. Code that relies on a
 * specific emission order within one transaction (e.g. `created` before
 * `toggled`) can do so safely.
 */
export type UnitOfWorkContext = Readonly<{
  todoRepository: TodoRepository;
  collectEvents: (events: readonly DomainEvent[]) => void;
}>;

export interface UnitOfWorkProvider {
  /**
   * Execute a callback within a single database transaction. Events handed
   * to `collectEvents` flush to the outbox in the same transaction, in call
   * order.
   */
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
