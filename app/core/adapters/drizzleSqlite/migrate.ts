import * as path from "node:path";
import { migrate as libsqlMigrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "./client";

export async function migrate(db: Database) {
  await libsqlMigrate(db, {
    migrationsFolder: path.join(__dirname, "migrations"),
  });
}
