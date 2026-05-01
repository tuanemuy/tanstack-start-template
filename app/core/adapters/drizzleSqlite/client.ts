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

async function enableWalMode(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode=WAL");
}

function isLocalFileUrl(url: string): boolean {
  return url.startsWith("file:");
}

/**
 * For local `file:` URLs the WAL PRAGMA is awaited before the database is
 * returned, so callers never query a connection still in rollback-journal
 * mode — that race would defeat the concurrency guarantees the outbox / UoW
 * retry paths rely on.
 */
export async function getDatabase(url: string): Promise<Database> {
  const normalizedUrl = normalizeFileUrl(url);
  const client = createClient({ url: normalizedUrl });

  if (isLocalFileUrl(url)) {
    await enableWalMode(client);
  }

  return drizzle(client, { schema });
}
