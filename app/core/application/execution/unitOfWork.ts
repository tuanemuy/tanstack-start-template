import type { DomainEvent } from "@/core/domain/common/event";
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";

export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  collectEvents(events: readonly DomainEvent[]): void;
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
