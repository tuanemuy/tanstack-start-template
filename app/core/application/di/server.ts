// Server-only. Reach via dynamic `import(...)` from any client-graph caller
// so the server adapter graph stays out of the client static graph; the
// framework's `server-only` marker is incompatible because its
// import-protection traces dynamic imports too.
import { content } from "@/config";
import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import { DrizzleSqliteOutboxRepository } from "@/core/adapters/drizzleSqlite/repositories/outboxRepository";
import { DrizzleSqliteUnitOfWorkProvider } from "@/core/adapters/drizzleSqlite/unitOfWork";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { AppConfig, Container, ServerConfig } from "./types";

export type { AppConfig, Container, ServerConfig } from "./types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set`);
  return value;
}

export function readServerConfig(): ServerConfig {
  return {
    ...content,
    databaseUrl: requireEnv("SQLITE_URL"),
    appUrl: requireEnv("APP_URL"),
  };
}

export async function createContainer(
  config: ServerConfig,
): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  const { databaseUrl: _databaseUrl, ...appConfig } = config;
  return {
    config: appConfig satisfies AppConfig,
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
