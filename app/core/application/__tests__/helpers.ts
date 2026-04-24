// app/core/application/__tests__/helpers.ts
// Test helper functions for application service tests

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/di/server";
import { RetryingUnitOfWorkProvider } from "@/core/application/execution/retryingUnitOfWork";
import { SystemClock } from "@/core/domain/common/ports/clock";
import { ConsoleLogger } from "@/core/domain/common/ports/logger";
import { FakeUnitOfWorkProvider } from "./fakes";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Test Database
// ============================================

/**
 * Test database instance
 */
export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Test database with cleanup function
 */
export type TestDatabaseWithCleanup = {
  db: TestDatabase;
  dbPath: string;
  cleanup: () => void;
};

/**
 * Create a test database (file-based SQLite)
 * Each call creates a new isolated database instance using a temporary file.
 *
 * Note: We use file-based SQLite instead of :memory: because libsql's
 * transaction implementation resets the db connection after each transaction,
 * which causes in-memory databases to lose their state between transactions.
 */
export async function createTestDatabase(): Promise<TestDatabaseWithCleanup> {
  // Create a unique temporary file for this test database
  const dbPath = path.join(
    os.tmpdir(),
    `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const client = createClient({ url: `file:${dbPath}` });
  // Enable WAL journaling + IMMEDIATE busy timeout so that concurrency tests
  // (optimistic-lock races, concurrent outbox workers) observe realistic
  // multi-writer semantics rather than being serialized by the default
  // rollback-journal lock model.
  await client.execute("PRAGMA journal_mode=WAL");
  // Busy-timeout lets BEGIN IMMEDIATE wait briefly for a contending writer
  // rather than erroring out. Required for the concurrent outbox-relay test
  // to run without exhausting the UoW retry budget.
  await client.execute("PRAGMA busy_timeout=5000");
  const db = drizzle(client, { schema });

  // Apply migrations
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
// Test Container
// ============================================

/**
 * Test container configuration options
 */
export type TestContainerOptions = {
  /**
   * Override the default config
   */
  config?: Partial<Container["config"]>;
  /**
   * Custom database instance (if not provided, a new file-based DB is created)
   */
  dbWithCleanup?: TestDatabaseWithCleanup;
};

/**
 * Test container with additional test utilities
 */
export type TestContainer = Container & {
  /**
   * Direct database access for test setup/assertions
   */
  db: TestDatabase;
  /**
   * Clean up test resources
   */
  cleanup: () => Promise<void>;
};

/**
 * Create a test container with real adapters (where possible) and mocks for external services
 */
export async function createTestContainer(
  options: TestContainerOptions = {},
): Promise<TestContainer> {
  const dbWithCleanup = options.dbWithCleanup ?? (await createTestDatabase());

  // Mirror the production wiring from `createContainer`: retry decorator on
  // top of the bare drizzle UoW. Without the decorator, concurrency tests
  // see raw `SQLITE_BUSY` instead of the post-retry behavior that actually
  // ships.
  const innerUow = new DrizzleSqliteUnitOfWorkProvider(dbWithCleanup.db);
  const unitOfWorkProvider = new RetryingUnitOfWorkProvider(
    innerUow,
    isRetryableError,
  );

  const container: TestContainer = {
    config: {
      appUrl: "http://localhost:3000",
      ...options.config,
    },
    unitOfWorkProvider,
    // Use the production wiring for clock and logger by default. Tests that
    // need deterministic time or assertable log capture build their own
    // container with `FakeClock` / `FakeLogger`.
    clock: SystemClock,
    logger: ConsoleLogger,
    // Test utilities
    db: dbWithCleanup.db,
    cleanup: async () => {
      dbWithCleanup.cleanup();
    },
  };

  return container;
}

/**
 * Setup test container with automatic cleanup
 *
 * This function sets up beforeEach/afterEach hooks to create and cleanup
 * the test container automatically. Use the returned getter function to
 * access the container in your tests.
 *
 * @example
 * ```typescript
 * const getContainer = setupTestContainer();
 *
 * it("should do something", async () => {
 *   const container = getContainer();
 *   // use container...
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

/**
 * Create mock headers for testing
 */
export function createMockHeaders(headers?: Record<string, string>): Headers {
  const h = new Headers();
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      h.set(key, value);
    }
  }
  return h;
}

// ============================================
// Fake In-Memory Test Container
// ============================================

/**
 * Test container backed by in-memory fakes (`FakeUnitOfWorkProvider` and
 * friends).
 *
 * Use this harness for usecase-level tests that exercise validation,
 * orchestration and event emission. It is ~10x faster than the Drizzle-
 * backed container because there is no file I/O, no migrations, and no
 * transaction overhead.
 *
 * Scope caveat: transactional rollback, concurrent-writer races, and
 * adapter-specific behaviour (e.g. `SQLITE_BUSY` retries) are NOT modelled
 * here. Tests that need those should use {@link setupTestContainer}
 * against real SQLite — typically co-located under a `*.integration.test.ts`
 * filename so they can be skipped in a tight local loop.
 */
export type FakeTestContainer = Container & {
  /**
   * Direct access to the underlying fake UoW provider so tests can inspect
   * collected events, seed the todo store, or pre-populate outbox rows
   * without going through a usecase.
   */
  fakeUow: FakeUnitOfWorkProvider;
};

export function createFakeTestContainer(
  options: { config?: Partial<Container["config"]> } = {},
): FakeTestContainer {
  const fakeUow = new FakeUnitOfWorkProvider();
  return {
    config: { appUrl: "http://localhost:3000", ...options.config },
    unitOfWorkProvider: fakeUow,
    // SystemClock by default — fast usecase tests that don't pin time still
    // get a working clock. Tests that need determinism construct a tailored
    // container with `FakeClock` and `FakeLogger`.
    clock: SystemClock,
    logger: ConsoleLogger,
    fakeUow,
  };
}

/**
 * Setup a fake in-memory container per test with automatic reset.
 *
 * No explicit `afterEach` cleanup is needed — the container is rebuilt from
 * scratch in `beforeEach`, so the previous test's state is simply dropped.
 *
 * @example
 * ```typescript
 * const getContainer = setupFakeTestContainer();
 * it("records a created event", async () => {
 *   const container = getContainer();
 *   await createTodo({ container, input: { title: "x" } });
 *   expect(container.fakeUow.getRecordedEvents()).toHaveLength(1);
 * });
 * ```
 */
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
// Test Data Factories
// ============================================
