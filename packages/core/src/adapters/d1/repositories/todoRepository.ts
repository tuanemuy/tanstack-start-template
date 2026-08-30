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
import type { OccProbe, PendingBatch } from "../pendingBatch";
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
 *
 * OCC is enforced by the `ExpectedVersion<Todo>` token returned from
 * `findById`. This file is the only legitimate construction
 * site of the token (via the `as` cast inside `toVersioned`) — the
 * brand keeps raw numbers out at every other call site.
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
      // Single statement so SQLite's statement-level atomicity gives a
      // coherent snapshot of items + total — no off-by-one window
      // between two parallel reads. `count(*) over()` projects the
      // unwindowed total onto each returned row.
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
        // Window-function trick yields no rows when the page is empty,
        // so fall back to a dedicated count. The result is still a
        // single read; concurrent writes between this and the prior
        // SELECT only matter when the caller paged past the tail,
        // which is already a benign UI edge case.
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

  // First-time persistence. Buffered like `save`; conflicts on the
  // primary key (rare — `Todo.create` mints a fresh id) surface as a
  // `SystemError` through `mapDbError` at flush time.
  async insert(todo: Todo): Promise<void> {
    this.pending.add(
      this.db.insert(todos).values({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        version: todo.version,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      }),
    );
  }

  // Buffered. Returns immediately; the actual write lands on the next
  // `db.batch()` call inside the UoW. The `Promise<void>` shape is
  // kept so domain / usecase code does not need to know whether a
  // write is synchronous or batched.
  async save(
    todo: Todo,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
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
      this.occProbe(todo.id, expectedVersion as number),
    );
  }

  async delete(
    id: TodoId,
    expectedVersion: ExpectedVersion<Todo>,
  ): Promise<void> {
    this.pending.addOcc(
      this.db
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
      this.occProbe(id, expectedVersion as number),
    );
  }

  // Post-abort attribution only (see `PendingBatch`): re-checks whether
  // the `id = ? AND version = ?` predicate of a buffered OCC write still
  // matches after the batch rolled back.
  private occProbe(id: TodoId, expectedVersion: number): OccProbe {
    return async () => {
      const rows = await this.db
        .select({ id: todos.id })
        .from(todos)
        .where(and(eq(todos.id, id), eq(todos.version, expectedVersion)))
        .limit(1);
      return rows.length > 0;
    };
  }
}
