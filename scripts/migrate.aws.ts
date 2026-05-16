// Run the libSQL migration set against a remote Turso instance. Differs
// from `migrate.node.ts` only in that it requires `DATABASE_URL` to be a
// `libsql://` URL with a matching `DATABASE_AUTH_TOKEN`. Everything else
// (schema, migration files, Drizzle dialect) is reused unchanged.
import "dotenv/config";

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
  applyPragmas,
  createLibsqlClient,
  getDatabase,
} from "@/core/adapters/libsql/client";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  const authToken = process.env["DATABASE_AUTH_TOKEN"];

  if (url === undefined || url === "") {
    throw new Error(
      "[migrate.aws] DATABASE_URL is required (expected `libsql://...` Turso URL)",
    );
  }
  if (!url.startsWith("libsql://") && !url.startsWith("https://")) {
    throw new Error(
      `[migrate.aws] expected libsql:// or https:// URL, got ${url}`,
    );
  }
  if (authToken === undefined || authToken === "") {
    throw new Error(
      "[migrate.aws] DATABASE_AUTH_TOKEN is required for remote Turso",
    );
  }

  const client = createLibsqlClient({ url, authToken });
  // Remote libSQL ignores PRAGMAs, but the call is harmless.
  await applyPragmas(client, {});

  const db = getDatabase(client);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(
    here,
    "../app/core/adapters/libsql/migrations",
  );

  console.log(
    `[migrate.aws] applying migrations from ${migrationsFolder} to ${url}`,
  );
  await migrate(db, { migrationsFolder });
  console.log("[migrate.aws] done");

  client.close();
}

main().catch((cause) => {
  console.error("[migrate.aws] failed", cause);
  process.exit(1);
});
