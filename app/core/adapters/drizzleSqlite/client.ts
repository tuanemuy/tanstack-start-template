import { type Client, createClient } from "@libsql/client";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import {
  drizzle,
  type LibSQLDatabase,
  type LibSQLTransaction,
} from "drizzle-orm/libsql";
import { normalizeFileUrl } from "@/lib/path";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema>;
export type Transaction = LibSQLTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type Executor = Database | Transaction;

/**
 * Enable WAL mode for local SQLite files
 * WAL mode improves concurrent read/write performance
 */
async function enableWalMode(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode=WAL");
}

/**
 * Check if the URL is a local file URL
 */
function isLocalFileUrl(url: string): boolean {
  return url.startsWith("file:");
}

/**
 * Create a database instance with WAL mode enabled for local files.
 *
 * For local `file:` URLs the WAL PRAGMA is awaited before the database is
 * returned, so callers never issue queries against a connection that is still
 * in rollback-journal mode. This avoids a race that defeats the concurrency
 * guarantees we rely on for the outbox / UoW retry paths.
 */
export async function getDatabase(url: string): Promise<Database> {
  const normalizedUrl = normalizeFileUrl(url);
  const client = createClient({ url: normalizedUrl });

  // Enable WAL mode for local files
  if (isLocalFileUrl(url)) {
    await enableWalMode(client);
  }

  return drizzle(client, { schema });
}
