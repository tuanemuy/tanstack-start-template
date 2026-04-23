import { and, desc, eq, sql } from "drizzle-orm";
import { ConflictError, ConflictErrorCode } from "@/core/application/error";
import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import { Todo } from "@/core/domain/todo/entity";
import type {
  TodoReader,
  TodoRepository,
} from "@/core/domain/todo/ports/todoRepository";
import type { TodoId } from "@/core/domain/todo/valueObject";
import type { Executor } from "../client";
import { todos } from "../schema";
import { mapDbError, rehydrate } from "./helpers";

/**
 * Read-only Drizzle implementation of `TodoReader`.
 *
 * Instantiated by the unit of work when `{ mode: "readonly" }` is requested
 * so that callers cannot call write methods even at the type level.
 */
export class DrizzleSqliteTodoReader implements TodoReader {
  constructor(protected readonly executor: Executor) {}

  findById(id: TodoId): Promise<Todo | null> {
    return mapDbError("Failed to find todo", async () => {
      const rows = await this.executor
        .select()
        .from(todos)
        .where(eq(todos.id, id))
        .limit(1);
      const row = rows[0];
      return row ? rehydrate("todo", () => Todo.fromPersistence(row)) : null;
    });
  }

  findAll(): Promise<Todo[]> {
    return mapDbError("Failed to list todos", async () => {
      const rows = await this.executor
        .select()
        .from(todos)
        .orderBy(desc(todos.createdAt));
      return rows.map((row) =>
        rehydrate("todo", () => Todo.fromPersistence(row)),
      );
    });
  }

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDbError("Failed to page todos", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      const [items, countRows] = await Promise.all([
        this.executor
          .select()
          .from(todos)
          .orderBy(desc(todos.createdAt))
          .limit(pagination.limit)
          .offset(offset),
        this.executor.select({ count: sql<number>`count(*)` }).from(todos),
      ]);
      return {
        items: items.map((row) =>
          rehydrate("todo", () => Todo.fromPersistence(row)),
        ),
        count: Number(countRows[0]?.count ?? 0),
      };
    });
  }
}

/**
 * Read/write Drizzle implementation of `TodoRepository`.
 *
 * Persists the aggregate using optimistic concurrency control:
 *
 * - `version === 0` is treated as a brand-new aggregate and issued as an
 *   INSERT. If the id already exists the DB's primary-key constraint
 *   surfaces as a `SystemError` (this is the "double-create" case, which
 *   indicates an application bug rather than a concurrent writer).
 * - `version > 0` is an update. We guard the update with
 *   `WHERE id = ? AND version = ? - 1` and inspect the `RETURNING` result:
 *   a zero-row update means another transaction wrote first, and we raise
 *   `ConflictError(OptimisticLockFailure)`.
 *
 * Upsert (`ON CONFLICT DO UPDATE`) is deliberately NOT used — it would hide
 * lost updates by silently clobbering the stored version.
 */
export class DrizzleSqliteTodoRepository
  extends DrizzleSqliteTodoReader
  implements TodoRepository
{
  async save(todo: Todo): Promise<void> {
    if (todo.version === 0) {
      await mapDbError("Failed to insert todo", async () => {
        await this.executor.insert(todos).values({
          id: todo.id,
          title: todo.title,
          completed: todo.status === "completed",
          version: todo.version,
          createdAt: todo.createdAt,
          updatedAt: todo.updatedAt,
        });
      });
      return;
    }

    const previousVersion = todo.version - 1;
    const updated = await mapDbError("Failed to update todo", () =>
      this.executor
        .update(todos)
        .set({
          title: todo.title,
          completed: todo.status === "completed",
          version: todo.version,
          updatedAt: todo.updatedAt,
        })
        .where(and(eq(todos.id, todo.id), eq(todos.version, previousVersion)))
        .returning({ id: todos.id }),
    );

    if (updated.length === 0) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while saving todo ${todo.id}: expected version ${previousVersion}`,
      );
    }
  }

  async delete(id: TodoId): Promise<void> {
    await mapDbError("Failed to delete todo", () =>
      this.executor.delete(todos).where(eq(todos.id, id)),
    );
  }
}
