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
   * Id-minting port. Usecases call `container.idGenerator.next()` for each
   * fresh id (aggregate, event) and pass the resulting string into the
   * domain factory. Same convention as `clock`: ambient I/O lives behind a
   * port; the domain only sees the resolved string.
   */
  idGenerator: IdGenerator;
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
 * Read server configuration from environment variables.
 *
 * Lazy: only invoked from {@link getContainer} (the production HTTP boot path)
 * or from out-of-band entry points (the seed script, ad-hoc CLIs) that
 * deliberately need server env. Importing this module does NOT trigger env
 * validation, so build-time analyzers and test harnesses can load the DI
 * surface without `SQLITE_URL` / `APP_URL` set.
 *
 * Exported so out-of-band entry points read env exactly the same way as the
 * server runtime — no parallel "fallback to localhost" defaults that drift.
 */
export function readServerConfig(): ServerConfig {
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
 * Lazily-constructed, memoized container for server runtime use.
 *
 * Env validation happens here (not at import time) so that tools that touch
 * the DI module — CLIs, scripts, build-time analyzers — don't need
 * `SQLITE_URL` / `APP_URL` set. The "fail fast on missing env" guarantee is
 * scoped to the first call from HTTP boot, not module load. Skipped under
 * `NODE_ENV === "test"` so tests can call {@link createContainer} directly.
 *
 * Memoizing the `Promise<Container>` (rather than the resolved value) ensures
 * concurrent callers during startup share a single initialization — no
 * duplicate DB connections, no duplicate WAL PRAGMA round-trips.
 */
let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "getContainer() is not available under NODE_ENV=test; tests must call createContainer({...}) directly",
    );
  }
  _containerPromise = createContainer(readServerConfig());
  return _containerPromise;
}
