import type { EventDraft } from "@repo/core/domain/common/event";
import type { TodoRepository } from "@repo/core/domain/todo/ports/todoRepository";

export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  /**
   * Enqueue domain event drafts for outbox flush at commit time.
   *
   * Drafts are identity-less by design — `EventId` is minted by the UoW
   * implementation against the application's `IdGenerator` port and
   * attached as the draft is buffered. Domain code therefore never touches
   * id generation, and usecases never thread `idGenerator` through manually.
   */
  collectEvents(drafts: readonly EventDraft[]): void;
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
