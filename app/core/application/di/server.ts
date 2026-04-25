/**
 * Server-side DI Container.
 *
 * Concrete wiring of adapters used by the application layer on the server.
 * Server-only — `server-only` import enforces that nothing referenced here
 * (including `process.env`) leaks into client bundles.
 */

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { OutboxRepository } from "@/core/domain/common/ports/outboxRepository";
import { RetryingUnitOfWorkProvider } from "../execution/retryingUnitOfWork";
import type { UnitOfWorkProvider } from "../execution/unitOfWork";
import { type Clock, SystemClock } from "../ports/clock";
import { ConsoleLogger, type Logger } from "../ports/logger";

export type AppConfig = {
  appUrl: string;
};

/**
 * Server-side DI container.
 *
 * Ports held here (DB pool, UoW provider) are long-lived and safe to share
 * across requests. Request-scoped concerns (per-request logger, auth context,
 * trace ids) do NOT belong here — add a sibling factory like
 * `createRequestContainer(headers)` instead.
 */
export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  /**
   * Outbox port for the relay worker. `save` is also called internally by
   * the unit of work when flushing collected events; usecases never touch
   * this directly — they emit events through `collectEvents` so writes
   * always run inside the same transaction as the entity changes that
   * produced them.
   */
  outboxRepository: OutboxRepository;
  /**
   * Clock port. Usecases call `container.clock.now()` once at the entry
   * point and pass the resulting `Date` into every domain operation that
   * needs a timestamp. Domain code never sees the port — only the resolved
   * `Date` value — keeping it pure.
   */
  clock: Clock;
  /**
   * Structured logger for cross-cutting observability (worker decode /
   * dispatch failures, etc.). Domain and usecase happy paths do not log.
   */
  logger: Logger;
};

export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
};

/**
 * Read server configuration from environment variables. Invoked lazily so
 * tooling that imports application modules without a full runtime env (e.g.
 * `drizzle-kit` generating migrations) does not fail at import time.
 */
function getServerConfig(): ServerConfig {
  const databaseUrl = process.env.SQLITE_URL;
  const appUrl = process.env.APP_URL;

  if (!databaseUrl)
    throw new Error("SQLITE_URL environment variable is not set");
  if (!appUrl) throw new Error("APP_URL environment variable is not set");

  return { databaseUrl, appUrl };
}

/**
 * Build a DI container from the given configuration. Tests and one-off scripts
 * call this directly with a custom config; production / SSR uses
 * {@link getContainer}, which memoizes a single instance.
 */
export async function createContainer(
  config: ServerConfig,
): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  // Wrap the bare adapter with the retry decorator so transient SQLITE_BUSY
  // contention is absorbed transparently. The `isRetryable` predicate is
  // adapter-specific (SQLite codes) — keeping retry as a decorator means
  // swapping drivers only requires supplying a new predicate.
  const unitOfWorkProvider = new RetryingUnitOfWorkProvider(
    new DrizzleSqliteUnitOfWorkProvider(db),
    isRetryableError,
  );
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider,
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    logger: ConsoleLogger,
  };
}

/**
 * Lazily-constructed, memoized container for server runtime use.
 *
 * Memoizing the `Promise<Container>` (rather than the resolved value) ensures
 * concurrent callers during startup share a single initialization — no
 * duplicate DB connections, no duplicate WAL PRAGMA round-trips.
 */
let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  _containerPromise = createContainer(getServerConfig());
  return _containerPromise;
}
