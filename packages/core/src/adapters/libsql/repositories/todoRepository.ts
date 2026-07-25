import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
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
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { todos } from "../schema";
import { mapDbError } from "./helpers";

type TodoRow = typeof todos.$inferSelect;

/**
 * libSQL `TodoRepository`. Reads run immediately; writes register
 * closures on the `PendingBatch` for the surrounding UoW to flush.
 * OCC is enforced via the `ExpectedVersion<Todo>` token returned from
 * `findById` — this file is the only legitimate construction site.
 */
export class LibsqlTodoRepository implements TodoRepository {
  constructor(
    private readonly db: Database,
    private readonly pending: PendingBatch,
    private readonly idGenerator: IdGenerator,
  ) {}

  private toTodo(row: TodoRow): Todo {
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

  private toVersioned(row: TodoRow): Versioned<Todo> {
    return {
      entity: this.toTodo(row),
      expectedVersion: row.version as ExpectedVersion<Todo>,
    };
  }

  findById(id: TodoId): Promise<Versioned<Todo> | null> {
    return mapDbError("Failed to find todo", async () => {
      const rows = await this.db
        .select()
        .from(todos)
        .where(eq(todos.id, id))
        .limit(1);
      const row = rows[0];
      return row ? this.toVersioned(row) : null;
    });
  }

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDbError("Failed to page todos", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      // `count(*) over()` projects the unwindowed total onto each row
      // so items + total come from one statement (no off-by-one window).
      const rows = await this.db
        .select({
          row: todos,
          total: sql<number>`count(*) over()`,
        })
        .from(todos)
        .orderBy(desc(todos.createdAt), desc(todos.id))
        .limit(pagination.limit)
        .offset(offset);

      if (rows.length === 0) {
        const countRows = await this.db
          .select({ count: sql<number>`count(*)` })
          .from(todos);
        return {
          items: [],
          count: Number(countRows[0]?.count ?? 0),
        };
      }

      return {
        items: rows.map(({ row }) => this.toTodo(row)),
        count: Number(rows[0].total),
      };
    });
  }

  async insert(todo: Todo): Promise<void> {
    this.pending.add((tx) =>
      tx.insert(todos).values({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        version: todo.version,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      }),
    );
  }

  async save(
    todo: Todo,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
    const todoId = todo.id;
    this.pending.addOcc(
      (tx) =>
        tx
          .update(todos)
          .set({
            title: todo.title,
            status: todo.status,
            version: todo.version,
            updatedAt: todo.updatedAt,
          })
          .where(
            and(
              eq(todos.id, todo.id),
              eq(todos.version, expectedVersion as number),
            ),
          ),
      () => {
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          `Optimistic lock failure while saving todo ${todoId}: expected version ${expectedVersion}`,
        );
      },
    );
  }

  async delete(
    id: TodoId,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
    this.pending.addOcc(
      (tx) =>
        tx
          .delete(todos)
          .where(
            and(eq(todos.id, id), eq(todos.version, expectedVersion as number)),
          ),
      () => {
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          `Optimistic lock failure while deleting todo ${id}: expected version ${expectedVersion}`,
        );
      },
    );
  }
}
