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

/**
 * Plug `TodoRepository` into the application-layer UoW context via TypeScript
 * declaration merging. Co-located with the port itself so the entire
 * "what shows up on the UoW context for this domain?" answer lives in one
 * place — adding a new domain repository means a sibling port file with its
 * own `declare module` block, no edits to the application layer.
 */
declare module "@/core/application/execution/unitOfWork" {
  interface UnitOfWorkContext {
    todoRepository: TodoRepository;
  }
}
