import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { pushSQLiteSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach } from "vitest";
import { content } from "@/config";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/di/types";
import { SystemClock } from "@/core/application/ports/clock";
import { UuidV7Generator } from "@/core/application/ports/idGenerator";
import { ConsoleLogger } from "@/core/application/ports/logger";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type TestDatabaseWithCleanup = {
  db: TestDatabase;
  cleanup: () => Promise<void>;
};

// Per-test on-disk SQLite under a unique temp dir. libsql does not let
// `cache=shared` memory DBs be name-disambiguated, so two parallel test
// files inside the same vitest worker would otherwise see each other's rows.
export async function createTestDatabase(): Promise<TestDatabaseWithCleanup> {
  const dir = mkdtempSync(join(tmpdir(), "tst-sqlite-"));
  const url = `file:${join(dir, "db.sqlite")}`;
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  const { apply } = await pushSQLiteSchema(schema, db);
  await apply();

  return {
    db,
    cleanup: async () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestContainerOptions = {
  config?: Partial<Container["config"]>;
  dbWithCleanup?: TestDatabaseWithCleanup;
};

export type TestContainer = Container & {
  db: TestDatabase;
};

export async function createTestContainer(
  options: TestContainerOptions = {},
): Promise<TestContainer> {
  const dbWithCleanup = options.dbWithCleanup ?? (await createTestDatabase());
  const db = dbWithCleanup.db;

  return {
    config: {
      ...content,
      appUrl: "http://localhost:3000",
      ...options.config,
    },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      await dbWithCleanup.cleanup();
    },
    db,
  };
}

export function setupTestContainer(
  options: TestContainerOptions = {},
): () => TestContainer {
  let container: TestContainer;
  beforeEach(async () => {
    container = await createTestContainer(options);
  });
  afterEach(async () => {
    await container.shutdown();
  });
  return () => container;
}

export function createMockHeaders(headers?: Record<string, string>): Headers {
  const h = new Headers();
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      h.set(key, value);
    }
  }
  return h;
}
