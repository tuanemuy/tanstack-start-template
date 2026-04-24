import { ConflictError, ConflictErrorCode } from "@/core/application/errors";
import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { Todo } from "@/core/domain/todo/entity";
import type {
  TodoReader,
  TodoRepository,
} from "@/core/domain/todo/ports/todoRepository";
import type { TodoId } from "@/core/domain/todo/valueObject";

/**
 * In-memory implementation of `TodoReader & TodoRepository` for fast
 * application-layer tests.
 *
 * Trade-offs vs. the real Drizzle adapter:
 *
 * - No transaction boundaries. Writes are visible to subsequent reads
 *   immediately. Tests that need real transactional semantics (rollback on
 *   error, isolation between workers) should use the Drizzle-backed
 *   `setupTestContainer` harness instead.
 * - Optimistic locking is modelled by comparing `version` against the
 *   currently stored row and throwing `ConflictError(OptimisticLockFailure)`
 *   on mismatch — same error shape as the production adapter so usecase
 *   tests that catch on `error.code` continue to work.
 * - No driver-level `SQLITE_BUSY`: nothing here is retryable, so pairing
 *   this fake with the production `RetryingUnitOfWorkProvider` does nothing
 *   useful. The matching `FakeUnitOfWorkProvider` skips the retry decorator.
 */
export class FakeTodoRepository implements TodoReader, TodoRepository {
  /**
   * Shared backing store. Passed in from the unit-of-work fake so that a
   * repository instance spun up for a given "transaction" sees the same
   * data as later instances; the fake does not attempt to simulate
   * snapshot isolation.
   */
  constructor(private readonly store: Map<TodoId, Todo>) {}

  async findById(id: TodoId): Promise<Todo | null> {
    return this.store.get(id) ?? null;
  }

  async findAll(): Promise<Todo[]> {
    // Mirror the real adapter's ordering (createdAt descending) so tests
    // that rely on order produce the same expectations against either
    // implementation.
    return Array.from(this.store.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    const all = await this.findAll();
    const offset = (pagination.page - 1) * pagination.limit;
    const items = all.slice(offset, offset + pagination.limit);
    return { items, count: all.length };
  }

  async save(todo: Todo): Promise<void> {
    const existing = this.store.get(todo.id);
    if (todo.version === 0) {
      if (existing !== undefined) {
        // Matches the real adapter's double-insert behavior: primary-key
        // collisions surface as an error rather than silently overwriting.
        throw new ConflictError(
          ConflictErrorCode.OptimisticLockFailure,
          `Fake double-insert for todo ${todo.id}`,
        );
      }
      this.store.set(todo.id, todo);
      return;
    }
    const expectedPrevious = todo.version - 1;
    if (!existing || existing.version !== expectedPrevious) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while saving todo ${todo.id}: expected version ${expectedPrevious}`,
      );
    }
    this.store.set(todo.id, todo);
  }

  async delete(id: TodoId, expectedVersion: number): Promise<void> {
    const existing = this.store.get(id);
    if (!existing || existing.version !== expectedVersion) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while deleting todo ${id}: expected version ${expectedVersion}`,
      );
    }
    this.store.delete(id);
  }
}
