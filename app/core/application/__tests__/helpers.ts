// Test harness for application-layer integration tests.
//
// Runs inside a Workers isolate via `vitest-pool-workers`; the
// `cloudflare:test` `env.DB` binding is a real D1 SQLite database
// (in-memory under Miniflare). Per-test row cleanup is owned by
// `app/core/adapters/d1/__tests__/setup.ts` (TRUNCATE in `beforeEach`),
// so the harness here is intentionally thin: each call to
// `createTestContainer()` just builds a fresh DI container around the
// shared binding.
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { content } from "@/config";
import { type Database, getDatabase } from "@/core/adapters/d1/client";
import { D1OutboxRepository } from "@/core/adapters/d1/repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "@/core/adapters/d1/unitOfWork";
import type { Container } from "@/core/application/di/types";
import { SystemClock } from "@/core/application/ports/clock";
import { UuidV7Generator } from "@/core/application/ports/idGenerator";
import { ConsoleLogger } from "@/core/application/ports/logger";

export type TestContainer = Container & {
  db: Database;
};

export function createTestContainer(): TestContainer {
  const db = getDatabase(env.DB);
  return {
    config: {
      ...content,
      appUrl: "http://localhost:8787",
    },
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      // D1 binding lifecycle is owned by Miniflare — no-op.
    },
    db,
  };
}

/**
 * Suite hook that yields a fresh `TestContainer` per test. Row
 * cleanup happens globally in the D1 pool's `setup.ts`, so this is
 * just a constructor + getter — no `afterEach` work is needed.
 */
export function setupTestContainer(): () => TestContainer {
  let container: TestContainer;
  beforeEach(() => {
    container = createTestContainer();
  });
  return () => container;
}
