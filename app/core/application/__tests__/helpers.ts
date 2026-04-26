import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach } from "vitest";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/di/server";
import { SystemClock } from "@/core/application/ports/clock";
import { ConsoleLogger } from "@/core/application/ports/logger";

// Migrations directory is resolved from CWD (project root) since vitest
// always runs from there. Using a static path keeps this file free of
// `import.meta.url` / `fileURLToPath` plumbing.
const MIGRATIONS_FOLDER = "app/core/adapters/drizzleSqlite/migrations";

// ============================================
// Test Database (real SQLite, in-memory)
// ============================================

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type TestDatabaseWithCleanup = {
  db: TestDatabase;
  cleanup: () => Promise<void>;
};

/**
 * Each call creates a fresh in-memory SQLite database.
 *
 * `cache=shared` is required because libsql opens a new physical connection
 * per `transaction()` call (see `Sqlite3Client.transaction` in the libsql
 * source); without shared cache every transaction would target an empty
 * database. Vitest's default `forks` pool runs each test file in its own
 * process, so the shared in-memory DB is naturally scoped per file —
 * sibling tests within one file are isolated by `cleanup` truncating the
 * tables, not by separate databases.
 */
export async function createTestDatabase(): Promise<TestDatabaseWithCleanup> {
  const client = createClient({ url: "file::memory:?cache=shared" });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    cleanup: async () => {
      // Truncate user tables so the next test starts clean. We do NOT
      // close the client — closing the last connection would drop the
      // shared in-memory DB and force the next `migrate` call to re-run.
      // Schema tables (`__drizzle_migrations`) are intentionally left
      // alone so subsequent `migrate` calls within the same process see
      // them and skip re-running.
      await db.delete(schema.outboxEvents);
      await db.delete(schema.todos);
    },
  };
}

// ============================================
// Drizzle-backed Test Container (integration tests)
// ============================================

export type TestContainerOptions = {
  config?: Partial<Container["config"]>;
  dbWithCleanup?: TestDatabaseWithCleanup;
};

export type TestContainer = Container & {
  db: TestDatabase;
  cleanup: () => Promise<void>;
};

export async function createTestContainer(
  options: TestContainerOptions = {},
): Promise<TestContainer> {
  const dbWithCleanup = options.dbWithCleanup ?? (await createTestDatabase());
  const db = dbWithCleanup.db;

  return {
    config: {
      appUrl: "http://localhost:3000",
      ...options.config,
    },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(db),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    logger: ConsoleLogger,
    db,
    cleanup: async () => {
      await dbWithCleanup.cleanup();
    },
  };
}

/**
 * beforeEach/afterEach helper that builds a fresh Drizzle-backed container
 * per test and tears it down on completion.
 *
 * @example
 * ```typescript
 * const getContainer = setupTestContainer();
 * it("does something", async () => {
 *   const container = getContainer();
 *   // ...
 * });
 * ```
 */
export function setupTestContainer(
  options: TestContainerOptions = {},
): () => TestContainer {
  let container: TestContainer;
  beforeEach(async () => {
    container = await createTestContainer(options);
  });
  afterEach(async () => {
    await container.cleanup();
  });
  return () => container;
}

// ============================================
// Mock Headers
// ============================================

export function createMockHeaders(headers?: Record<string, string>): Headers {
  const h = new Headers();
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      h.set(key, value);
    }
  }
  return h;
}
