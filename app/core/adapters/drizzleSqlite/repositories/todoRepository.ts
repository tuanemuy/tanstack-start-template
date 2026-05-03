import { and, desc, eq, sql } from "drizzle-orm";
import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@/core/application/errors";
import { isUuidV7 } from "@/core/application/ports/idGenerator";
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
import type { TodoRepository } from "@/core/domain/todo/ports/todoRepository";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import type { Executor } from "../client";
import { todos } from "../schema";
import { mapDbError } from "./helpers";

type TodoRow = typeof todos.$inferSelect;

function toTodo(row: TodoRow): Todo {
  try {
    if (!Number.isInteger(row.version) || row.version < 0) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored todo has invalid version: ${row.version}`,
      );
    }
    if (row.status !== "active" && row.status !== "completed") {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored todo has invalid status: ${row.status}`,
      );
    }
    if (!isUuidV7(row.id)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored todo has malformed id: ${row.id}`,
      );
    }
    const base = {
      id: TodoId.create(row.id),
      title: TodoTitle.create(row.title),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return row.status === "completed"
      ? ({ ...base, status: "completed" } satisfies CompletedTodo)
      : ({ ...base, status: "active" } satisfies ActiveTodo);
  } catch (error) {
    if (error instanceof SystemError) throw error;
    const message =
      error instanceof BusinessRuleError
        ? "Stored todo violates invariants"
        : "Failed to map stored todo row";
    throw new SystemError(SystemErrorCode.DataIntegrityError, message, error);
  }
}

export class DrizzleSqliteTodoRepository implements TodoRepository {
  constructor(private readonly executor: Executor) {}

  findById(id: string): Promise<Todo | null> {
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

  findPage(pagination: Pagination): Promise<PaginationResult<Todo>> {
    return mapDbError("Failed to page todos", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      const [rows, countRows] = await Promise.all([
        this.executor
          .select()
          .from(todos)
          .orderBy(desc(todos.createdAt), desc(todos.id))
          .limit(pagination.limit)
          .offset(offset),
        this.executor.select({ count: sql<number>`count(*)` }).from(todos),
      ]);
      return {
        items: rows.map(toTodo),
        count: Number(countRows[0]?.count ?? 0),
      };
    });
  }

  async save(todo: Todo): Promise<void> {
    if (todo.version === 0) {
      await mapDbError("Failed to insert todo", async () => {
        await this.executor.insert(todos).values({
          id: todo.id,
          title: todo.title,
          status: todo.status,
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
          status: todo.status,
          version: todo.version,
          updatedAt: todo.updatedAt,
        })
        .where(and(eq(todos.id, todo.id), eq(todos.version, previousVersion)))
        .returning({ id: todos.id }),
    );

    if (updated.length === 0) {
      throw new ConflictError(
        "OPTIMISTIC_LOCK_FAILURE",
        `Optimistic lock failure while saving todo ${todo.id}: expected version ${previousVersion}`,
      );
    }
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    const deleted = await mapDbError("Failed to delete todo", () =>
      this.executor
        .delete(todos)
        .where(and(eq(todos.id, id), eq(todos.version, expectedVersion)))
        .returning({ id: todos.id }),
    );
    if (deleted.length === 0) {
      throw new ConflictError(
        "OPTIMISTIC_LOCK_FAILURE",
        `Optimistic lock failure while deleting todo ${id}: expected version ${expectedVersion}`,
      );
    }
  }
}
