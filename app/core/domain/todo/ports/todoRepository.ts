import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { Todo } from "../entity";
import type { TodoId } from "../valueObject";

/**
 * Persistence port for the Todo aggregate.
 *
 * `delete` is optimistic-lock-guarded by `expectedVersion` — adapters must
 * scope the DELETE to `WHERE id = ? AND version = expectedVersion` and
 * raise `ConflictError(OptimisticLockFailure)` on a zero-row delete so
 * concurrent writer/deleter races cannot lose updates silently.
 */
export interface TodoRepository {
  findById(id: TodoId): Promise<Todo | null>;
  findAll(): Promise<Todo[]>;
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
  save(todo: Todo): Promise<void>;
  delete(id: TodoId, expectedVersion: number): Promise<void>;
}
