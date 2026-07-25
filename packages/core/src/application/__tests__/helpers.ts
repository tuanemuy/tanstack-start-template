// Test harness for application-layer integration tests.
//
// Runs inside a Workers isolate via `vitest-pool-workers`; the
// `cloudflare:test` `env.DB` binding is a real D1 SQLite database
// (in-memory under Miniflare). Per-test row cleanup is owned by
// `packages/core/src/adapters/d1/__tests__/setup.ts` (TRUNCATE in `beforeEach`),
// so the harness here is intentionally thin: each call to
// `createTestContainer()` just builds a fresh DI container around the
// shared binding.
import { env } from "cloudflare:test";
import { type Database, getDatabase } from "@repo/core/adapters/d1/client";
import { D1IdempotencyStore } from "@repo/core/adapters/d1/repositories/idempotencyStore";
import { D1OutboxRepository } from "@repo/core/adapters/d1/repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "@repo/core/adapters/d1/unitOfWork";
import type {
  RequestContainer,
  WorkerContainer,
} from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { beforeEach } from "vitest";

// Tests need both scopes — they exercise usecases (request) and worker
// pipelines in the same suite. Production code uses one container or
// the other, never this fat shape.
export type TestContainer = RequestContainer &
  WorkerContainer & {
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
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator, SystemClock),
    idempotencyStore: new D1IdempotencyStore(db, SystemClock),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
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
