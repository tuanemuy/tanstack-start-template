import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { Container, ServerConfig } from "./types";

export type { AppConfig, Container, ServerConfig } from "./types";

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
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(db, SystemClock),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      db.$client.close();
      resetContainer();
    },
  };
}

let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  _containerPromise = createContainer(readServerConfig());
  return _containerPromise;
}

export function resetContainer(): void {
  _containerPromise = null;
}
