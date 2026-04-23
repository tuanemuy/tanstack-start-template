/**
 * Server-side DI Container.
 *
 * Concrete wiring of adapters used by the application layer on the server.
 * This module is server-only — enforced via the `server-only` import — so
 * anything referenced here (including `process.env`) is guaranteed not to
 * leak into client bundles.
 */

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import { RetryingUnitOfWorkProvider } from "../retryingUnitOfWork";
import type { UnitOfWorkProvider } from "../unitOfWork";

/**
 * Application configuration shared across the DI container.
 */
export type AppConfig = {
  appUrl: string;
};

/**
 * Server-side DI container.
 *
 * When extending, prefer adding new ports here rather than constructing
 * adapters ad-hoc from application services.
 */
export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
};

/**
 * Server environment configuration.
 */
export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
};

/**
 * Read server configuration from environment variables.
 *
 * Deliberately invoked lazily (see {@link getContainer}) so that tooling
 * which imports application modules without a full runtime env — such as
 * `drizzle-kit` generating migrations — does not fail at import time.
 */
function getServerConfig(): ServerConfig {
  const databaseUrl = process.env.SQLITE_URL;
  const appUrl = process.env.APP_URL;

  if (!databaseUrl) {
    throw new Error("SQLITE_URL environment variable is not set");
  }

  if (!appUrl) {
    throw new Error("APP_URL environment variable is not set");
  }

  return { databaseUrl, appUrl };
}

/**
 * Build a DI container from the given configuration.
 *
 * Exposed so tests and one-off scripts can inject a custom config without
 * touching `process.env`. Production/SSR code should call {@link getContainer}
 * which memoizes a single instance derived from the runtime environment.
 *
 * Async because `getDatabase` awaits the WAL PRAGMA for local file URLs; the
 * container is only handed out after the connection is confirmed to be in
 * WAL mode so that early queries cannot race the mode switch.
 *
 * The UoW is composed as `Retrying(DrizzleSqlite(db))` so that transient
 * write-lock contention retries cross-cut the adapter without the adapter
 * knowing about it.
 */
export async function createContainer(
  config: ServerConfig,
): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  const innerUow = new DrizzleSqliteUnitOfWorkProvider(db);
  const unitOfWorkProvider = new RetryingUnitOfWorkProvider(
    innerUow,
    isRetryableError,
  );

  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider,
  };
}

/**
 * Lazily-constructed, memoized container for server runtime use.
 *
 * The first call reads `process.env` via {@link getServerConfig} and kicks
 * off async container construction; subsequent calls return the same
 * in-flight or resolved promise. Memoizing the `Promise<Container>` (rather
 * than the resolved value) ensures that concurrent callers during startup
 * share a single initialization — no duplicate DB connections, no duplicate
 * WAL PRAGMA round-trips, and no chance of observing a half-initialized
 * container.
 *
 * This avoids blowing up at import time when tooling or the client bundler
 * accidentally pulls in this module without the runtime env being populated.
 *
 * Intentionally a process-wide singleton. Ports held here (DB pool, UoW
 * provider) are long-lived and safe to share across requests. Request-scoped
 * concerns — per-request logger, tenant/auth context, trace IDs, or ports
 * that close over caller identity — do NOT belong here; threading them
 * through the singleton would leak request state across requests. If/when
 * such concerns are introduced, add a sibling entry point (e.g.
 * `createRequestContainer(headers)`) that composes request-scoped ports on
 * top of the shared singleton, and have server components / server
 * functions call that factory instead of {@link getContainer} directly.
 */
let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  _containerPromise = createContainer(getServerConfig());
  return _containerPromise;
}
