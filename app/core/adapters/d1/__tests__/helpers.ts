import { env } from "cloudflare:test";
import { content } from "@/config";
import type { Container } from "@/core/application/di/types";
import { SystemClock } from "@/core/application/ports/clock";
import { UuidV7Generator } from "@/core/application/ports/idGenerator";
import { ConsoleLogger } from "@/core/application/ports/logger";
import { type Database, getDatabase } from "../client";
import { D1OutboxRepository } from "../repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "../unitOfWork";

export type TestContainer = Container & {
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
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      // D1 binding is process-managed by Miniflare — nothing to close.
    },
    db,
  };
}
