import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { Todo } from "../entity";

/**
 * Persistence port for the Todo aggregate.
 *
 * Lookup keys are plain `string` — branding to `TodoId` lives at the
 * rehydration boundary (`toTodo` in the adapter, the event decoder). Both
 * `save` and `delete` are guarded by the entity's `version` (OCC) — a
 * stale write surfaces as `ConflictError("OPTIMISTIC_LOCK_FAILURE")`.
 */
export interface TodoRepository {
  findById(id: string): Promise<Todo | null>;
  findAll(): Promise<Todo[]>;
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
  save(todo: Todo): Promise<void>;
  delete(id: string, expectedVersion: number): Promise<void>;
}
