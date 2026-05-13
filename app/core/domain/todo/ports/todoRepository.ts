import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import type { TransactionalRepository } from "@/core/domain/common/transactionalRepository";
import type { Todo } from "../entity";

/**
 * `TodoRepository` inherits the OCC-enforced contract
 * (`insert` / `findById` / `save` / `delete`) from
 * `TransactionalRepository<Todo>` and adds the read-only paging
 * query that listing usecases need.
 *
 * Read-only single-item lookups are intentionally absent — any read
 * by id must declare its write intent via `findById` so the
 * captured `ExpectedVersion<Todo>` token reaches the matching write.
 */
export interface TodoRepository extends TransactionalRepository<Todo> {
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
}
