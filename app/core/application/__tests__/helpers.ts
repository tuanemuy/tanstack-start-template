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
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/container/server";

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

  const container: TestContainer = {
    config: {
      appUrl: "http://localhost:3000",
      sessionTimeoutHours: 24,
      maxSessionsPerUser: 3,
      ...options.config,
    },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(dbWithCleanup.db),
    // ... other adapters and services would be initialized here
    // Test utilities
    db: dbWithCleanup.db,
    cleanup: async () => {
      // Clean up the temporary database file
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
// Test Data Factories
// ============================================
