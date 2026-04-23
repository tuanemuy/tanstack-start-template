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
 * The UoW is composed as `Retrying(DrizzleSqlite(db))` so that transient
 * write-lock contention retries cross-cut the adapter without the adapter
 * knowing about it.
 */
export function createContainer(config: ServerConfig): Container {
  const db = getDatabase(config.databaseUrl);
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
 * The first call reads `process.env` via {@link getServerConfig}; subsequent
 * calls return the cached instance. This avoids blowing up at import time
 * when tooling or the client bundler accidentally pulls in this module
 * without the runtime env being populated.
 */
let _container: Container | null = null;
export function getContainer(): Container {
  if (_container !== null) return _container;
  _container = createContainer(getServerConfig());
  return _container;
}
