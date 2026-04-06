/**
 * Server-side DI Container
 *
 * This file provides the concrete implementation of the server container
 * with all necessary adapters for server-side operations.
 */

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import type { Container } from "@/core/application/container/server";

/**
 * Server configuration type
 */
export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
};

/**
 * Read server configuration from environment variables
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

  return {
    databaseUrl,
    appUrl,
  };
}

/**
 * Create a DI container with the given configuration
 */
export function createContainer(config: ServerConfig): Container {
  const db = getDatabase(config.databaseUrl);
  const unitOfWorkProvider = new DrizzleSqliteUnitOfWorkProvider(db);

  return {
    config: {
      appUrl: config.appUrl,
    },
    unitOfWorkProvider,
    // ... other dependencies can be added here
  };
}

export const container = createContainer(getServerConfig());
