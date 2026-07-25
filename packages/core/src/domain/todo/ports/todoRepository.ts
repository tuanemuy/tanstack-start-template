import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";
import type { TransactionalRepository } from "@repo/core/domain/common/transactionalRepository";
import type { Todo } from "../entity";
import type { TodoId } from "../valueObject";

/**
 * `TodoRepository` inherits the OCC-enforced contract
 * (`insert` / `findById` / `save` / `delete`) from
 * `TransactionalRepository<Todo, TodoId>` and adds the read-only paging
 * query that listing usecases need.
 *
 * The lookup key is the branded `TodoId`, not a raw `string`: callers
 * construct it through `TodoId.create` at the usecase boundary, so the
 * id-format invariant is checked before the lookup and a foreign id
 * cannot reach this port.
 *
 * Read-only single-item lookups are intentionally absent — any read
 * by id must declare its write intent via `findById` so the
 * captured `ExpectedVersion<Todo>` token reaches the matching write.
 */
export interface TodoRepository extends TransactionalRepository<Todo, TodoId> {
  findPage(pagination: Pagination): Promise<PaginationResult<Todo>>;
}
