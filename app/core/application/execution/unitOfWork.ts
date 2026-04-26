import type { DomainEvent } from "@/core/domain/common/event";

/**
 * Per-callback context passed into the UoW callback. Carries `collectEvents`
 * for atomic outbox publishing plus every domain repository the callback
 * needs to touch — but the repository slots are NOT enumerated here.
 *
 * ## Open / closed via declaration merging
 *
 * Each domain owns a port file (e.g.
 * `core/domain/todo/ports/todoRepository.ts`) that augments this interface
 * with its own repository slot:
 *
 * ```ts
 * // core/domain/<your-domain>/ports/<repo>.ts
 * declare module "@/core/application/execution/unitOfWork" {
 *   interface UnitOfWorkContext {
 *     yourRepository: YourRepository;
 *   }
 * }
 * ```
 *
 * That single `declare module` block is the only edit a new domain needs —
 * the application-layer file you're reading right now does not change, and
 * neither does any other domain's port. The adapter's `unitOfWork.ts`
 * implementation must wire the corresponding repository instance when it
 * builds the context object; that's the only counterpart edit.
 *
 * Why declaration merging over a parametric `UnitOfWorkContext<TRepos>`:
 * usecase signatures stay readable
 * (`async ({ todoRepository, collectEvents }) => …`) and there is no need
 * for every usecase to spell out which repo subset it touches.
 *
 * ## Ordering invariant
 *
 * `collectEvents` appends to an internal buffer in **call order**, and the
 * buffer is flushed to the outbox in that same order. Code that relies on a
 * specific emission order within one transaction (e.g. `created` before
 * `toggled`) can do so safely.
 */
export interface UnitOfWorkContext {
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
