import { env } from "cloudflare:test";
import type {
  RequestContainer,
  WorkerContainer,
} from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { type Database, getDatabase } from "../client";
import { D1IdempotencyStore } from "../repositories/idempotencyStore";
import { D1OutboxRepository } from "../repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "../unitOfWork";

// Tests need both scopes — they seed via UoW (request) and assert via
// the outbox repo / idempotency store (worker). The fat shape is
// test-only; production code uses one container or the other.
export type TestContainer = RequestContainer &
  WorkerContainer & {
    db: Database;
  };

/**
 * Builds a fresh container around the test-isolate's `env.DB` D1 binding.
 *
 * The binding is a singleton per Workers isolate but row cleanup is
 * driven by the file-level `setup.ts` (TRUNCATE in `beforeEach`), so
 * each test sees a clean database.
 */
export function createTestContainer(): TestContainer {
  const db = getDatabase(env.DB);
  return {
    config: {
      ...content,
      appUrl: "http://localhost:3000",
    },
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    // The relay-worker variant of the outbox repo (no PendingBatch).
    // UoW-internal saves go through a per-UoW instance constructed
    // inside `D1UnitOfWorkProvider.run`.
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator, SystemClock),
    idempotencyStore: new D1IdempotencyStore(db, SystemClock),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    db,
  };
}
