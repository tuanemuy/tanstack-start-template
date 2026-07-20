import { existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { createLibsqlClient, type Database, getDatabase } from "../client";
import { LibsqlIdempotencyStore } from "../repositories/idempotencyStore";
import { LibsqlOutboxRepository } from "../repositories/outboxRepository";
import { LibsqlUnitOfWorkProvider } from "../unitOfWork";

const MIGRATION_PATH = path.resolve(
  import.meta.dirname,
  "../migrations/0000_initial.sql",
);

/** Test container bundling request- and worker-side dependencies. */
export type TestContainer = Readonly<{
  unitOfWorkProvider: LibsqlUnitOfWorkProvider;
  outboxRepository: LibsqlOutboxRepository;
  idempotencyStore: LibsqlIdempotencyStore;
  db: Database;
  client: Client;
  clock: typeof SystemClock;
  idGenerator: typeof UuidV7Generator;
  logger: typeof ConsoleLogger;
  close: () => void;
}>;

/**
 * Builds an isolated libSQL DB backed by a per-test temp file, applies
 * the initial migration, and wires a full container.
 *
 * Temp file (not `:memory:`): libSQL's sqlite3 backend reopens its
 * connection on `client.transaction()`, and a fresh `:memory:`
 * connection cannot see the schema of the previous one.
 *
 * Caller must invoke `close()` (typically in `afterEach`).
 */
export async function createTestContainer(): Promise<TestContainer> {
  const dbPath = path.join(
    os.tmpdir(),
    `libsql-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createLibsqlClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");

  const ddl = readFileSync(MIGRATION_PATH, "utf8");
  // Strip drizzle's statement-breakpoint markers; libSQL's
  // executeMultiple consumes a plain semicolon-delimited script.
  await client.executeMultiple(ddl.replace(/--> statement-breakpoint/g, ""));

  const db = getDatabase(client);
  return {
    unitOfWorkProvider: new LibsqlUnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    outboxRepository: new LibsqlOutboxRepository(
      db,
      UuidV7Generator,
      SystemClock,
    ),
    idempotencyStore: new LibsqlIdempotencyStore(db, SystemClock),
    db,
    client,
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    close: () => {
      client.close();
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(file)) unlinkSync(file);
      }
    },
  };
}
