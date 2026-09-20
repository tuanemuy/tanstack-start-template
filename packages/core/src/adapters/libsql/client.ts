import {
  type Client,
  createClient,
  type InArgs,
  type InStatement,
  LibsqlError,
  type Replicated,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * Drizzle handle without `transaction`. Atomic writes go through
 * `db.batch()`: on a local file it runs `BEGIN` … `COMMIT` as one
 * synchronous call on the client's single connection, so writes within a
 * process never interleave.
 *
 * An interactive transaction breaks that in two ways. It stays open
 * across `await`s while the binding is synchronous, so a second writer
 * blocks the event loop the lock holder needs to commit. And the driver
 * hands its connection over to each transaction, then lazily opens a
 * fresh one that carries none of the PRAGMAs.
 */
export type Database = Omit<LibSQLDatabase<typeof schema>, "transaction">;

export type CreateLibsqlClientOptions = Readonly<{
  url: string;
  authToken?: string;
  encryptionKey?: string;
}>;

export type PragmaOptions = Readonly<{
  wal?: boolean;
  busyTimeoutMs?: number;
}>;

/**
 * Creates a libSQL client. URLs may be `file:`, `:memory:`, or any
 * remote form the driver supports. PRAGMAs are not applied here — open
 * the handle with {@link openDatabase} in production paths.
 */
export function createLibsqlClient(options: CreateLibsqlClientOptions): Client {
  return createClient({
    url: options.url,
    ...(options.authToken !== undefined
      ? { authToken: options.authToken }
      : {}),
    ...(options.encryptionKey !== undefined
      ? { encryptionKey: options.encryptionKey }
      : {}),
  });
}

/**
 * Apply production PRAGMAs: `WAL` (readers unblocked by single writer),
 * `foreign_keys=ON` (match D1 default), `busy_timeout` (5000 ms unless
 * overridden). `busy_timeout` only covers a lock held by another process
 * (a migration, the `sqlite3` CLI), and the wait blocks the event loop;
 * writes within the process never contend — see {@link Database}.
 * Pass `wal: false` for `:memory:` test databases.
 *
 * `foreign_keys` and `busy_timeout` are per-connection.
 * {@link openDatabase} re-applies them when the connection is reopened.
 */
export async function applyPragmas(
  client: Client,
  options: PragmaOptions = {},
): Promise<void> {
  for (const statement of pragmaStatements(options)) {
    await client.execute(statement);
  }
}

function pragmaStatements(options: PragmaOptions): string[] {
  return [
    ...((options.wal ?? true) ? ["PRAGMA journal_mode = WAL"] : []),
    "PRAGMA foreign_keys = ON",
    `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`,
  ];
}

/**
 * Wraps a libSQL `Client` into a Drizzle handle pre-bound to the project
 * schema. Caller owns the client lifecycle (`client.close()` at shutdown).
 */
export function getDatabase(client: Client): Database {
  return drizzle({ client, schema });
}

/**
 * Applies the PRAGMAs and returns a Drizzle handle that keeps them for
 * the life of the client. Caller owns the client lifecycle.
 */
export async function openDatabase(
  client: Client,
  pragmas: PragmaOptions = {},
): Promise<Database> {
  await applyPragmas(client, pragmas);
  // A remote client has no local connection to reopen.
  return getDatabase(
    client.protocol === "file"
      ? new BusyReopeningClient(client, pragmas)
      : client,
  );
}

function isBusy(error: unknown): boolean {
  return error instanceof LibsqlError && error.code.startsWith("SQLITE_BUSY");
}

/**
 * Once a statement fails with `SQLITE_BUSY`, every later `COMMIT` on the
 * same connection fails with "cannot commit transaction - SQL statements
 * in progress" (libsql 0.5). The connection never recovers on its own, so
 * it is reopened — and its PRAGMAs re-applied — before the error surfaces.
 */
class BusyReopeningClient implements Client {
  constructor(
    private readonly inner: Client,
    private readonly pragmas: PragmaOptions,
  ) {}

  get closed(): boolean {
    return this.inner.closed;
  }

  get protocol(): string {
    return this.inner.protocol;
  }

  execute(stmt: InStatement): Promise<ResultSet>;
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  execute(stmtOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
    return this.reopenOnBusy(() =>
      typeof stmtOrSql === "string"
        ? this.inner.execute(stmtOrSql, args)
        : this.inner.execute(stmtOrSql),
    );
  }

  batch(
    stmts: Array<InStatement | [string, InArgs?]>,
    mode?: TransactionMode,
  ): Promise<ResultSet[]> {
    return this.reopenOnBusy(() => this.inner.batch(stmts, mode));
  }

  migrate(stmts: InStatement[]): Promise<ResultSet[]> {
    return this.reopenOnBusy(() => this.inner.migrate(stmts));
  }

  // Unreachable through `Database`; refuses a caller that casts its way
  // to the client.
  async transaction(): Promise<Transaction> {
    throw new Error(
      "Interactive transactions are disabled on a local libSQL file: use db.batch()",
    );
  }

  executeMultiple(sql: string): Promise<void> {
    return this.reopenOnBusy(() => this.inner.executeMultiple(sql));
  }

  sync(): Promise<Replicated> {
    return this.inner.sync();
  }

  close(): void {
    this.inner.close();
  }

  // The driver runs each call synchronously up to the promise it returns,
  // so issuing them back to back leaves no turn in which another operation
  // finds the fresh connection without its PRAGMAs.
  async reconnect(): Promise<void> {
    await Promise.all([
      this.inner.reconnect(),
      ...pragmaStatements(this.pragmas).map((statement) =>
        this.inner.execute(statement),
      ),
    ]);
  }

  private async reopenOnBusy<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (isBusy(error)) {
        // A failed reopen must not replace the `SQLITE_BUSY` the caller
        // has to see; the next operation reports a connection still broken.
        await this.reconnect().catch(() => {});
      }
      throw error;
    }
  }
}
