import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";
import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { isRehydrationError } from "@repo/core/domain/error";
import { Todo } from "@repo/core/domain/todo/entity";
import type { TodoRepository } from "@repo/core/domain/todo/ports/todoRepository";
import type { TodoId } from "@repo/core/domain/todo/valueObject";
import { mapDoError } from "./helpers";
import type {
  TodoStateClient,
  TodoStateRow,
  TodoWriteCommand,
} from "./protocol";

/**
 * Request-Worker implementation of `TodoRepository` over the
 * todo-state DO's RPC surface. Reads execute immediately against the
 * stub; writes accumulate as plain `TodoWriteCommand`s on the buffer
 * owned by the surrounding `DoUnitOfWorkProvider`, which ships them in
 * one `commit` RPC so the DO applies everything in a single real
 * transaction.
 *
 * Read-your-write within the same UoW is unsupported by design, same
 * as the D1 adapter: usecases mutate the loaded aggregate in memory
 * and persist once.
 */
export class DoTodoRepository implements TodoRepository {
  constructor(
    private readonly client: TodoStateClient,
    private readonly writes: TodoWriteCommand[],
    private readonly idGenerator: IdGenerator,
  ) {}

  private toTodo(row: TodoStateRow): Todo {
    if (!this.idGenerator.validate(row.id)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored todo has malformed id: ${row.id}`,
      );
    }
    try {
      return Todo.reconstruct(row);
    } catch (error) {
      if (isRehydrationError(error)) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "Stored todo violates invariants",
          error,
        );
      }
      throw error;
    }
  }

  findById(id: TodoId): Promise<Versioned<Todo> | null> {
    return mapDoError("Failed to find todo", async () => {
      const row = await this.client.findTodoById(id);
      if (row === null) return null;
      return {
        entity: this.toTodo(row),
        expectedVersion: row.version as ExpectedVersion<Todo>,
      };
    });
  }

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDoError("Failed to page todos", async () => {
      const page = await this.client.findTodoPage(pagination);
      return {
        items: page.items.map((row) => this.toTodo(row)),
        count: page.count,
      };
    });
  }

  private static toRow(todo: Todo): TodoStateRow {
    return {
      id: todo.id,
      title: todo.title,
      status: todo.status,
      version: todo.version,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    };
  }

  async insert(todo: Todo): Promise<void> {
    this.writes.push({ kind: "insert", row: DoTodoRepository.toRow(todo) });
  }

  async save(
    todo: Todo,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
    this.writes.push({
      kind: "save",
      row: DoTodoRepository.toRow(todo),
      expectedVersion: expectedVersion as number,
    });
  }

  async delete(
    id: TodoId,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
    this.writes.push({
      kind: "delete",
      id,
      expectedVersion: expectedVersion as number,
    });
  }
}
