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
 * Create a database instance with optional WAL mode for local files
 *
 * Note: For local SQLite files, WAL mode is enabled asynchronously.
 * Use `getDatabaseAsync` if you need to ensure WAL mode is enabled before use.
 */
export function getDatabase(url: string): Database {
  const normalizedUrl = normalizeFileUrl(url);
  const client = createClient({ url: normalizedUrl });

  // Enable WAL mode for local files (fire and forget)
  if (isLocalFileUrl(url)) {
    enableWalMode(client).catch((err) => {
      console.warn("Failed to enable WAL mode:", err);
    });
  }

  return drizzle(client, { schema });
}

/**
 * Create a database instance with WAL mode enabled (async version)
 * Use this when you need to ensure WAL mode is enabled before performing operations
 */
export async function getDatabaseAsync(url: string): Promise<Database> {
  const normalizedUrl = normalizeFileUrl(url);
  const client = createClient({ url: normalizedUrl });

  // Enable WAL mode for local files
  if (isLocalFileUrl(url)) {
    await enableWalMode(client);
  }

  return drizzle(client, { schema });
}
