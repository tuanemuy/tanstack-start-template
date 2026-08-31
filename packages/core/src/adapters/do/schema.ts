import type { SqlExec } from "./sql";

/**
 * DO-local schema. Mirrors the D1 adapter's tables minus `_occ_guard`:
 * DO SQLite has real interactive transactions (`transactionSync`), so
 * OCC failures abort by throwing inside the transaction instead of the
 * deferred-batch CHECK-constraint trick.
 *
 * Applied idempotently from the DO constructor — the constructor runs
 * before any request is delivered to the object, and DO SQLite is
 * synchronous, so there is no window where a request can observe a
 * half-migrated store. Additive changes extend this list with more
 * `IF NOT EXISTS` statements; destructive changes need a versioned
 * migration ledger (a `_meta` table) which this template intentionally
 * leaves out.
 */
const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // Backs findTodoPage's `ORDER BY created_at DESC, id DESC` paging key.
  `CREATE INDEX IF NOT EXISTS idx_todos_created_id
     ON todos (created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS outbox_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    processed_at INTEGER,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at INTEGER,
    failed_at INTEGER,
    claimed_at INTEGER,
    claimed_by TEXT
  )`,
  // Pending slice for the alarm relay; quarantined rows
  // (`failed_at IS NOT NULL`) are excluded so a poison row stops
  // polluting the hot path.
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending
     ON outbox_events (next_attempt_at, created_at, id)
     WHERE processed_at IS NULL AND failed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS processed_events (
    id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  )`,
];

export function applyDoSchema(sql: SqlExec): void {
  for (const statement of DDL) {
    sql.exec(statement);
  }
}
