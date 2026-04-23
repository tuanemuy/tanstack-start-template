import type { DomainEvent } from "@/core/domain/common/event";
import type {
  OutboxReader,
  OutboxRepository,
} from "@/core/domain/common/ports/outboxRepository";
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
 */
export type ReadonlyContext = Readonly<{
  todoRepository: TodoReader;
  outboxRepository: OutboxReader;
}>;

/**
 * Repositories visible inside a read/write unit of work, plus `collectEvent`
 * for publishing domain events atomically via the outbox pattern.
 *
 * Events collected here are persisted to the outbox in the same transaction
 * once the callback resolves.
 */
export type ReadWriteContext = Readonly<{
  todoRepository: TodoRepository;
  outboxRepository: OutboxRepository;
  collectEvent: (event: DomainEvent) => void;
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
}
