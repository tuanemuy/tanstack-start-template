/**
 * Structural subset of the Workers `SqlStorage` API (Durable Object
 * SQLite). Declared locally instead of importing
 * `@cloudflare/workers-types` so every module in this adapter group
 * except the entry-point wiring stays free of platform type imports —
 * the DO class in `apps/web` passes its `ctx.storage.sql` straight in,
 * and tests can substitute any object with the same shape.
 */
export type SqlValue = ArrayBuffer | string | number | null;

export type SqlRow = Record<string, SqlValue>;

export interface SqlCursor<T extends SqlRow = SqlRow> {
  toArray(): T[];
  readonly rowsWritten: number;
}

export interface SqlExec {
  exec<T extends SqlRow = SqlRow>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursor<T>;
}

/**
 * `ctx.storage.transactionSync` as a structural capability: runs `fn`
 * atomically and rolls back if it throws. The callback must stay
 * synchronous — DO SQLite executes synchronously, which is what makes
 * a real interactive transaction possible here (unlike D1's deferred
 * batch).
 */
export type TransactionRunner = <T>(fn: () => T) => T;
