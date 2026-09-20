import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import {
  createLibsqlClient,
  type Database,
  openDatabase,
  type PragmaOptions,
} from "../client";
import { migrateDatabase } from "../migrate";
import { LibsqlIdempotencyStore } from "../repositories/idempotencyStore";
import { LibsqlOutboxRepository } from "../repositories/outboxRepository";
import { LibsqlUnitOfWorkProvider } from "../unitOfWork";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/** Test container bundling request- and worker-side dependencies. */
export type TestContainer = Readonly<{
  unitOfWorkProvider: LibsqlUnitOfWorkProvider;
  outboxRepository: LibsqlOutboxRepository;
  idempotencyStore: LibsqlIdempotencyStore;
  db: Database;
  client: Client;
  /** `file:` URL of the backing temp file, for opening a rival connection. */
  url: string;
  clock: typeof SystemClock;
  idGenerator: typeof UuidV7Generator;
  logger: typeof ConsoleLogger;
  close: () => void;
}>;

/**
 * Builds an isolated libSQL DB backed by a per-test temp file, applies
 * the drizzle migrations, and wires a full container.
 *
 * Temp file (not `:memory:`): contention tests open a second connection
 * to the same database, which a private `:memory:` database cannot offer.
 *
 * Caller must invoke `close()` (typically in `afterEach`).
 */
export async function createTestContainer(
  pragmas: PragmaOptions = {},
): Promise<TestContainer> {
  const dbPath = path.join(
    os.tmpdir(),
    `libsql-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const url = `file:${dbPath}`;
  const client = createLibsqlClient({ url });
  const db = await openDatabase(client, pragmas);

  if (!existsSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"))) {
    throw new Error(
      `No migrations in ${MIGRATIONS_DIR}. Run \`pnpm db:generate:node\` first.`,
    );
  }

  await migrateDatabase(client, MIGRATIONS_DIR);
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
    url,
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
