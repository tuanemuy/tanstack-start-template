/**
 * Server-side DI Container. `server-only` enforces that nothing referenced
 * here (including `process.env`) leaks into client bundles.
 */

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { UnitOfWorkProvider } from "../execution/unitOfWork";
import { type Clock, SystemClock } from "../ports/clock";
import { type IdGenerator, UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger, type Logger } from "../ports/logger";
import type { OutboxRepository } from "../ports/outboxRepository";

export type AppConfig = {
  appUrl: string;
};

/**
 * Long-lived process-scoped container. Per-request concerns (auth context,
 * trace ids, request-scoped logger) belong in a separate factory like
 * `createRequestContainer(headers)` — do not add them here.
 */
export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  /**
   * Outbox port for the relay worker. `save` is called internally by the
   * unit of work; usecases never touch this directly — they emit events
   * through `collectEvents`.
   */
  outboxRepository: OutboxRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
};

export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
};

/**
 * Read server configuration from environment variables. Lazy: only invoked
 * from {@link getContainer} or out-of-band entry points (the seed script,
 * ad-hoc CLIs). Importing this module does NOT trigger env validation.
 */
export function readServerConfig(): ServerConfig {
  const databaseUrl = process.env.SQLITE_URL;
  const appUrl = process.env.APP_URL;

  if (!databaseUrl)
    throw new Error("SQLITE_URL environment variable is not set");
  if (!appUrl) throw new Error("APP_URL environment variable is not set");

  return { databaseUrl, appUrl };
}

export async function createContainer(
  config: ServerConfig,
): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(db),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/**
 * Lazily-constructed, memoized container. Memoizing the `Promise<Container>`
 * (not the resolved value) ensures concurrent callers during startup share
 * a single initialization — no duplicate DB connections, no duplicate WAL
 * PRAGMA round-trips. Tests bypass this and call {@link createContainer}.
 */
let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  _containerPromise = createContainer(readServerConfig());
  return _containerPromise;
}
