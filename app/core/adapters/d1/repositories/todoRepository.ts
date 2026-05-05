import { and, desc, eq, sql } from "drizzle-orm";
import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@/core/application/errors";
import type { IdGenerator } from "@/core/application/ports/idGenerator";
import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import { Todo } from "@/core/domain/todo/entity";
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { todos } from "../schema";
import { mapDbError } from "./helpers";

type TodoRow = typeof todos.$inferSelect;

/**
 * D1 implementation of `TodoRepository`. Reads execute immediately
 * against the binding (no transaction); writes register Drizzle query
 * expressions on the supplied `PendingBatch` so the surrounding
 * `D1UnitOfWorkProvider` can flush them atomically via `db.batch()`.
 *
 * Read-your-write within the same UoW is intentionally not supported:
 * DDD usecases mutate the loaded aggregate in memory and persist once,
 * so this is not a constraint in practice. If a usecase ever needs the
 * post-write row back from D1, the UoW must commit first and the next
 * UoW reads from a fresh state.
 */
export class D1TodoRepository implements TodoRepository {
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
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "Stored todo violates invariants",
        error,
      );
    }
  }

  findById(id: string): Promise<Todo | null> {
    return mapDbError("Failed to find todo", async () => {
      const rows = await this.db
        .select()
        .from(todos)
        .where(eq(todos.id, id))
        .limit(1);
      const row = rows[0];
      return row ? this.toTodo(row) : null;
    });
  }

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDbError("Failed to page todos", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      const [rows, countRows] = await Promise.all([
        this.db
          .select()
          .from(todos)
          .orderBy(desc(todos.createdAt), desc(todos.id))
          .limit(pagination.limit)
          .offset(offset),
        this.db.select({ count: sql<number>`count(*)` }).from(todos),
      ]);
      return {
        items: rows.map((row) => this.toTodo(row)),
        count: Number(countRows[0]?.count ?? 0),
      };
    });
  }

  // Buffered. Returns immediately; the actual write lands on the next
  // `db.batch()` call inside the UoW. The `Promise<void>` shape is kept
  // so domain / usecase code is identical to the libSQL adapter.
  async save(todo: Todo): Promise<void> {
    if (todo.version === 0) {
      this.pending.add(
        this.db.insert(todos).values({
          id: todo.id,
          title: todo.title,
          status: todo.status,
          version: 0,
          createdAt: todo.createdAt,
          updatedAt: todo.updatedAt,
        }),
      );
      return;
    }

    const previousVersion = todo.version - 1;
    const todoId = todo.id;
    this.pending.addOcc(
      this.db
        .update(todos)
        .set({
          title: todo.title,
          status: todo.status,
          version: todo.version,
          updatedAt: todo.updatedAt,
        })
        .where(and(eq(todos.id, todo.id), eq(todos.version, previousVersion))),
      () => {
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          `Optimistic lock failure while saving todo ${todoId}: expected version ${previousVersion}`,
        );
      },
    );
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    this.pending.addOcc(
      this.db
        .delete(todos)
        .where(and(eq(todos.id, id), eq(todos.version, expectedVersion))),
      () => {
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          `Optimistic lock failure while deleting todo ${id}: expected version ${expectedVersion}`,
        );
      },
    );
  }
}
