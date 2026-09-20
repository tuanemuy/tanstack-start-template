import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

/**
 * Applies the drizzle migrations in `migrationsFolder`. Drizzle's migrator
 * takes the full handle, which `Database` is not, so the handle is built
 * here and never leaves this function.
 */
export function migrateDatabase(
  client: Client,
  migrationsFolder: string,
): Promise<void> {
  return migrate(drizzle({ client }), { migrationsFolder });
}
