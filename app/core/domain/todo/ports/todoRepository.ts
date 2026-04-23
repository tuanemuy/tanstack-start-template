import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { Todo } from "../entity";
import type { TodoId } from "../valueObject";

/**
 * Read-only view of the todo aggregate store.
 *
 * A readonly unit of work exposes this narrow interface so that usecases
 * running in `{ mode: "readonly" }` cannot call `save` / `delete` even at the
 * type level — the guarantee is structural, not a runtime trap.
 */
export interface TodoReader {
  findById(id: TodoId): Promise<Todo | null>;
  findAll(): Promise<Todo[]>;
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
}

/**
 * Full read/write repository. Extends `TodoReader` so any reader call site
 * works against a write-capable repo too.
 *
 * `delete` is optimistic-lock-guarded by `expectedVersion` — adapters must
 * scope the DELETE to `WHERE id = ? AND version = expectedVersion` and
 * raise `ConflictError(OptimisticLockFailure)` on a zero-row delete so
 * concurrent writer/deleter races cannot lose updates silently.
 */
export interface TodoRepository extends TodoReader {
  save(todo: Todo): Promise<void>;
  delete(id: TodoId, expectedVersion: number): Promise<void>;
}
