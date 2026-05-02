import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { Todo } from "../entity";

// `save` / `delete` are OCC-guarded by entity `version`; stale writes surface
// as `ConflictError("OPTIMISTIC_LOCK_FAILURE")`.
export interface TodoRepository {
  findById(id: string): Promise<Todo | null>;
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
  save(todo: Todo): Promise<void>;
  delete(id: string, expectedVersion: number): Promise<void>;
}
