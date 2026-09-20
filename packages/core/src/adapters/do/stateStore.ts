import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";
import type { CommitRequest, CommitResult, TodoStateRow } from "./protocol";
import type { SqlExec, SqlRow, TransactionRunner } from "./sql";

/**
 * DO-side todo persistence. Every function here runs inside the
 * Durable Object, where SQLite access is synchronous and the object is
 * single-threaded: statements issued without an intervening `await`
 * cannot interleave with any other request, so multi-statement reads
 * observe a coherent snapshot without an explicit transaction.
 */

type TodoDbRow = Readonly<{
  id: string;
  title: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
}> &
  SqlRow;

const TODO_COLUMNS = "id, title, status, version, created_at, updated_at";

function toStateRow(row: TodoDbRow): TodoStateRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)),
    updatedAt: new Date(Number(row.updated_at)),
  };
}

export function findTodoById(sql: SqlExec, id: string): TodoStateRow | null {
  const rows = sql
    .exec<TodoDbRow>(`SELECT ${TODO_COLUMNS} FROM todos WHERE id = ?`, id)
    .toArray();
  const row = rows[0];
  return row ? toStateRow(row) : null;
}

export function findTodoPage(
  sql: SqlExec,
  pagination: Pagination,
): PaginationResult<TodoStateRow> {
  const offset = (pagination.page - 1) * pagination.limit;
  const rows = sql
    .exec<TodoDbRow>(
      `SELECT ${TODO_COLUMNS} FROM todos
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      pagination.limit,
      offset,
    )
    .toArray();
  const count = sql
    .exec<{ c: number } & SqlRow>("SELECT count(*) AS c FROM todos")
    .toArray();
  return {
    items: rows.map(toStateRow),
    count: Number(count[0]?.c ?? 0),
  };
}

// Both are thrown inside the transaction to abort it; caught by
// `applyCommit` and returned as data. Never escape this module.
class OccConflict {
  constructor(
    readonly command: "save" | "delete",
    readonly todoId: string,
    readonly expectedVersion: number,
  ) {}
}

class DuplicateInsert {
  constructor(readonly todoId: string) {}
}

/**
 * Applies one unit of work's buffered writes plus its outbox events in
 * a single transaction. OCC is a per-statement conditional write —
 * `WHERE id = ? AND version = ? RETURNING 1` — so the check closes
 * over exactly one statement and a conflict names the exact command
 * that lost, with everything before it rolled back. An insert onto an
 * existing id is reported the same way rather than left to throw: a
 * thrown constraint error would cross RPC as a plain `Error` and reach
 * the caller as a `SystemError`, where libSQL / D1 answer
 * `ConflictError("UNIQUE_VIOLATION")`.
 */
export function applyCommit(
  sql: SqlExec,
  runInTransaction: TransactionRunner,
  request: CommitRequest,
  now: Date,
): CommitResult {
  try {
    runInTransaction(() => {
      for (const command of request.writes) {
        switch (command.kind) {
          case "insert": {
            const { row } = command;
            const inserted = sql
              .exec(
                `INSERT INTO todos (id, title, status, version, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (id) DO NOTHING RETURNING 1 AS ok`,
                row.id,
                row.title,
                row.status,
                row.version,
                row.createdAt.getTime(),
                row.updatedAt.getTime(),
              )
              .toArray();
            if (inserted.length === 0) {
              throw new DuplicateInsert(row.id);
            }
            break;
          }
          case "save": {
            const { row, expectedVersion } = command;
            const updated = sql
              .exec(
                `UPDATE todos SET title = ?, status = ?, version = ?, updated_at = ?
                   WHERE id = ? AND version = ? RETURNING 1 AS ok`,
                row.title,
                row.status,
                row.version,
                row.updatedAt.getTime(),
                row.id,
                expectedVersion,
              )
              .toArray();
            if (updated.length === 0) {
              throw new OccConflict("save", row.id, expectedVersion);
            }
            break;
          }
          case "delete": {
            const deleted = sql
              .exec(
                "DELETE FROM todos WHERE id = ? AND version = ? RETURNING 1 AS ok",
                command.id,
                command.expectedVersion,
              )
              .toArray();
            if (deleted.length === 0) {
              throw new OccConflict(
                "delete",
                command.id,
                command.expectedVersion,
              );
            }
            break;
          }
        }
      }
      for (const event of request.events) {
        sql.exec(
          `INSERT INTO outbox_events
             (id, event_type, aggregate_id, payload, occurred_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          event.id,
          event.type,
          event.aggregateId,
          JSON.stringify(event.payload),
          event.occurredAt.getTime(),
          now.getTime(),
        );
      }
    });
  } catch (error) {
    if (error instanceof OccConflict) {
      return {
        kind: "conflict",
        command: error.command,
        todoId: error.todoId,
        expectedVersion: error.expectedVersion,
      };
    }
    if (error instanceof DuplicateInsert) {
      return { kind: "conflict", command: "insert", todoId: error.todoId };
    }
    throw error;
  }
  return { kind: "committed" };
}
