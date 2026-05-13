import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema>;

export type CreateLibsqlClientOptions = Readonly<{
  url: string;
  authToken?: string;
  encryptionKey?: string;
}>;

/**
 * Creates a libSQL client. URLs may be `file:`, `:memory:`, or any
 * remote form the driver supports. PRAGMAs are not applied here — call
 * {@link applyPragmas} after construction in production paths.
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
 * `foreign_keys=ON` (match D1 default), `busy_timeout=5000` (the only
 * buffer against transient contention — the UoW does not retry).
 * Pass `wal: false` for `:memory:` test databases.
 */
export async function applyPragmas(
  client: Client,
  options: { wal?: boolean } = {},
): Promise<void> {
  const wal = options.wal ?? true;
  if (wal) {
    await client.execute("PRAGMA journal_mode = WAL");
  }
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
}

/**
 * Wraps a libSQL `Client` into a Drizzle handle pre-bound to the project
 * schema. Caller owns the client lifecycle (`client.close()` at shutdown).
 */
export function getDatabase(client: Client): Database {
  return drizzle(client, { schema });
}
