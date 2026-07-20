import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  applyPragmas,
  createLibsqlClient,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";

const DEFAULT_DATABASE_URL = "file:./data/app.db";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  const authToken = process.env["DATABASE_AUTH_TOKEN"];
  const encryptionKey = process.env["DATABASE_ENCRYPTION_KEY"];

  // libSQL's embedded driver fails to open a `file:` URL whose parent
  // directory does not exist; pre-create it.
  if (url.startsWith("file:")) {
    const filePath = url.slice("file:".length);
    const parent = path.dirname(path.resolve(process.cwd(), filePath));
    fs.mkdirSync(parent, { recursive: true });
  }

  const client = createLibsqlClient({
    url,
    ...(authToken !== undefined ? { authToken } : {}),
    ...(encryptionKey !== undefined ? { encryptionKey } : {}),
  });
  const isMemory = url === ":memory:";
  await applyPragmas(client, isMemory ? { wal: false } : {});

  const db = getDatabase(client);

  // Resolve relative to this file so cwd doesn't affect the lookup.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(
    here,
    "../../../packages/core/src/adapters/libsql/migrations",
  );

  console.log(
    `[migrate.node] applying migrations from ${migrationsFolder} to ${url}`,
  );
  await migrate(db, { migrationsFolder });
  console.log("[migrate.node] done");

  client.close();
}

main().catch((cause) => {
  console.error("[migrate.node] failed", cause);
  process.exit(1);
});
