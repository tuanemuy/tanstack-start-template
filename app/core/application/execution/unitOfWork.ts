import type { DomainEvent } from "@/core/domain/common/event";
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";

/**
 * Per-callback context exposing every domain repository the callback can
 * touch plus `collectEvents` for atomic outbox publishing. Adding a new
 * domain is a one-line edit here and a wiring edit in the adapter.
 *
 * `collectEvents` appends to an internal buffer in **call order** and is
 * flushed to the outbox in that same order once the callback resolves.
 */
export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  collectEvents(events: readonly DomainEvent[]): void;
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
