// Run the libSQL migration set against a remote Turso instance. Schema,
// migration files, and Drizzle dialect are shared with `migrate.node.ts`.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLibsqlClient } from "@repo/core/adapters/libsql/client";
import { migrateDatabase } from "@repo/core/adapters/libsql/migrate";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("[migrate.aws] DATABASE_URL is required");
  }
  const authToken = process.env["DATABASE_AUTH_TOKEN"];

  const client = createLibsqlClient({
    url,
    ...(authToken !== undefined && authToken !== "" ? { authToken } : {}),
  });

  const migrationsFolder = path.resolve(
    scriptDir,
    "../../../packages/core/src/adapters/libsql/migrations",
  );

  console.log(
    `[migrate.aws] applying migrations from ${migrationsFolder} to ${url}`,
  );
  await migrateDatabase(client, migrationsFolder);
  console.log("[migrate.aws] done");

  client.close();
}

main().catch((cause) => {
  console.error("[migrate.aws] failed", cause);
  process.exit(1);
});
