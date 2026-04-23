import { and, desc, eq, sql } from "drizzle-orm";
import {
  ConflictError,
  ConflictErrorCode,
  SystemError,
  SystemErrorCode,
} from "@/core/application/error";
import type {
  Pagination,
  PaginationResult,
} from "@/core/domain/common/pagination";
import { BusinessRuleError } from "@/core/domain/error";
import type {
  ActiveTodo,
  CompletedTodo,
  Todo,
} from "@/core/domain/todo/entity";
import type {
  TodoReader,
  TodoRepository,
} from "@/core/domain/todo/ports/todoRepository";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import type { Executor } from "../client";
import { todos } from "../schema";
import { mapDbError } from "./helpers";

type TodoRow = typeof todos.$inferSelect;

/**
 * Convert a raw persisted row into a `Todo` aggregate.
 *
 * Runs every column through its value-object factory so invariants are
 * re-checked on read, and lifts the flat `completed` column into the
 * `active | completed` discriminated union.
 *
 * A `BusinessRuleError` from any VO factory here means the stored row
 * violates a domain invariant — that is infrastructural corruption, not a
 * user-recoverable rule violation, so it is re-thrown as
 * `SystemError(DatabaseError)` with the original error retained in the
 * `cause` chain.
 */
function toTodo(row: TodoRow): Todo {
  try {
    if (!Number.isInteger(row.version) || row.version < 0) {
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        `Stored todo has invalid version: ${row.version}`,
      );
    }
    const base = {
      id: TodoId.create(row.id),
      title: TodoTitle.create(row.title),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return row.completed
      ? ({ ...base, status: "completed" } satisfies CompletedTodo)
      : ({ ...base, status: "active" } satisfies ActiveTodo);
  } catch (error) {
    if (error instanceof SystemError) throw error;
    const message =
      error instanceof BusinessRuleError
        ? "Stored todo violates invariants"
        : "Failed to map stored todo row";
    throw new SystemError(SystemErrorCode.DatabaseError, message, error);
  }
}

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
      return row ? toTodo(row) : null;
    });
  }

  findAll(): Promise<Todo[]> {
    return mapDbError("Failed to list todos", async () => {
      const rows = await this.executor
        .select()
        .from(todos)
        .orderBy(desc(todos.createdAt));
      return rows.map(toTodo);
    });
  }

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDbError("Failed to page todos", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      // Sequential awaits rather than Promise.all: SQLite serializes per
      // connection anyway, and some libsql driver versions fault when two
      // statements are issued concurrently on the same executor.
      const items = await this.executor
        .select()
        .from(todos)
        .orderBy(desc(todos.createdAt))
        .limit(pagination.limit)
        .offset(offset);
      // If a filter is ever added to the list query above, the same WHERE
      // must be applied here — otherwise `count` drifts from `items`.
      const countRows = await this.executor
        .select({ count: sql<number>`count(*)` })
        .from(todos);
      return {
        items: items.map(toTodo),
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
 * Delete is similarly guarded by the caller-supplied `expectedVersion`
 * (the version read by the usecase), so a concurrent writer that has
 * already advanced the version causes the DELETE to match zero rows and
 * surface as a `ConflictError(OptimisticLockFailure)`.
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

  async delete(id: TodoId, expectedVersion: number): Promise<void> {
    const deleted = await mapDbError("Failed to delete todo", () =>
      this.executor
        .delete(todos)
        .where(and(eq(todos.id, id), eq(todos.version, expectedVersion)))
        .returning({ id: todos.id }),
    );
    if (deleted.length === 0) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while deleting todo ${id}: expected version ${expectedVersion}`,
      );
    }
  }
}
