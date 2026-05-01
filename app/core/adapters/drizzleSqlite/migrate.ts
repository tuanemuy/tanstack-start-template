import { fileURLToPath } from "node:url";
import { migrate as libsqlMigrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "./client";

export async function migrate(db: Database) {
  await libsqlMigrate(db, {
    migrationsFolder: fileURLToPath(new URL("migrations", import.meta.url)),
  });
}
