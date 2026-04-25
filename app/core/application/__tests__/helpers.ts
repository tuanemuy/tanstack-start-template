import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach } from "vitest";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/di/server";
import { RetryingUnitOfWorkProvider } from "@/core/application/execution/retryingUnitOfWork";
import { SystemClock } from "@/core/application/ports/clock";
import { ConsoleLogger } from "@/core/application/ports/logger";
import {
  FakeOutboxRepository,
  type FakeOutboxRow,
} from "./fakes/fakeOutboxRepository";
import { FakeUnitOfWorkProvider } from "./fakes/fakeUnitOfWork";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Test Database (real SQLite, file-based)
// ============================================

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type TestDatabaseWithCleanup = {
  db: TestDatabase;
  dbPath: string;
  cleanup: () => void;
};

/**
 * Each call creates a unique temporary file-backed SQLite. We use file-based
 * (not `:memory:`) because libsql resets the connection after each
 * transaction, which loses in-memory state.
 */
export async function createTestDatabase(): Promise<TestDatabaseWithCleanup> {
  const dbPath = path.join(
    os.tmpdir(),
    `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA busy_timeout=5000");
  const db = drizzle(client, { schema });

  const migrationsFolder = path.join(
    __dirname,
    "../../adapters/drizzleSqlite/migrations",
  );
  await migrate(db, { migrationsFolder });

  return {
    db,
    dbPath,
    cleanup: () => {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors
      }
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
    unitOfWorkProvider: new RetryingUnitOfWorkProvider(
      new DrizzleSqliteUnitOfWorkProvider(db),
      isRetryableError,
    ),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    logger: ConsoleLogger,
    db,
    cleanup: async () => {
      dbWithCleanup.cleanup();
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
// Fake In-Memory Test Container (unit tests)
// ============================================

export type FakeTestContainer = Container & {
  fakeUow: FakeUnitOfWorkProvider;
  /** Shared row buffer between the UoW fake and the outbox fake. */
  outboxRows: FakeOutboxRow[];
};

export function createFakeTestContainer(
  options: { config?: Partial<Container["config"]> } = {},
): FakeTestContainer {
  const fakeUow = new FakeUnitOfWorkProvider();
  return {
    config: { appUrl: "http://localhost:3000", ...options.config },
    unitOfWorkProvider: fakeUow,
    outboxRepository: new FakeOutboxRepository(fakeUow.outboxRows),
    clock: SystemClock,
    logger: ConsoleLogger,
    fakeUow,
    outboxRows: fakeUow.outboxRows,
  };
}

export function setupFakeTestContainer(
  options: { config?: Partial<Container["config"]> } = {},
): () => FakeTestContainer {
  let container: FakeTestContainer;
  beforeEach(() => {
    container = createFakeTestContainer(options);
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
