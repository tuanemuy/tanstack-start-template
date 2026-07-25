// Deliberately separate from `./serverCloudflare.ts` so the CF entry
// never pulls libSQL / node-only imports and vice versa. Both factories
// return the same `RequestContainer` / `WorkerContainer` shapes.

import type { Database } from "@repo/core/adapters/libsql/client";
import { LibsqlIdempotencyStore } from "@repo/core/adapters/libsql/repositories/idempotencyStore";
import { LibsqlOutboxRepository } from "@repo/core/adapters/libsql/repositories/outboxRepository";
import { LibsqlUnitOfWorkProvider } from "@repo/core/adapters/libsql/unitOfWork";
import { content } from "@repo/core/config";
import { z } from "zod";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { NoopRelayTrigger, type RelayTrigger } from "../ports/relayTrigger";
import type { TuningEnv } from "./env";
import type {
  AppConfig,
  RequestContainer,
  SharedDeps,
  WorkerContainer,
} from "./types";

/**
 * Node-side env shape. `DATABASE_URL` follows the libSQL URL grammar
 * (`file:`, `:memory:`, `libsql:`, ...).
 */
export type NodeServerEnv = Readonly<{
  DATABASE_URL: string;
  DATABASE_AUTH_TOKEN?: string | undefined;
  DATABASE_ENCRYPTION_KEY?: string | undefined;
  APP_URL: string;
  PORT?: string | undefined;
  HOSTNAME?: string | undefined;
  OUTBOX_BATCH_SIZE?: string | undefined;
  OUTBOX_LEASE_MS?: string | undefined;
  OUTBOX_MAX_ATTEMPTS?: string | undefined;
  OUTBOX_RETENTION_MS?: string | undefined;
}>;

const nodeServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  DATABASE_ENCRYPTION_KEY: z.string().min(1).optional(),
  APP_URL: z.string().min(1, "APP_URL is required"),
  PORT: z.string().optional(),
  HOSTNAME: z.string().optional(),
  OUTBOX_BATCH_SIZE: z.string().optional(),
  OUTBOX_LEASE_MS: z.string().optional(),
  OUTBOX_MAX_ATTEMPTS: z.string().optional(),
  OUTBOX_RETENTION_MS: z.string().optional(),
});

/**
 * Validates `process.env`-shaped input against the Node-runtime surface.
 */
export function readNodeServerEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeServerEnv {
  return nodeServerEnvSchema.parse(source);
}

/** Projection of {@link NodeServerEnv} to the runtime-agnostic tuning shape. */
export function nodeServerEnvToTuningEnv(env: NodeServerEnv): TuningEnv {
  return {
    ...(env.OUTBOX_BATCH_SIZE !== undefined
      ? { OUTBOX_BATCH_SIZE: env.OUTBOX_BATCH_SIZE }
      : {}),
    ...(env.OUTBOX_LEASE_MS !== undefined
      ? { OUTBOX_LEASE_MS: env.OUTBOX_LEASE_MS }
      : {}),
    ...(env.OUTBOX_MAX_ATTEMPTS !== undefined
      ? { OUTBOX_MAX_ATTEMPTS: env.OUTBOX_MAX_ATTEMPTS }
      : {}),
    ...(env.OUTBOX_RETENTION_MS !== undefined
      ? { OUTBOX_RETENTION_MS: env.OUTBOX_RETENTION_MS }
      : {}),
  };
}

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/**
 * Request-path config. `db` and `relayTrigger` are resolved once at
 * boot and reused across requests (no per-request binding like CF's D1).
 */
export type NodeRequestServerConfig = AppConfig &
  Readonly<{
    db: Database;
    relayTrigger: RelayTrigger;
  }>;

export function readNodeRequestServerConfig(
  env: NodeServerEnv,
  bindings: { db: Database; relayTrigger?: RelayTrigger },
): NodeRequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    db: bindings.db,
    relayTrigger: bindings.relayTrigger ?? NoopRelayTrigger,
  };
}

/** Build the request-scoped container for the Node runtime. */
export function createNodeRequestContainer(
  config: NodeRequestServerConfig,
): RequestContainer {
  const { db: _db, relayTrigger: _relayTrigger, ...appConfig } = config;
  return {
    ...buildSharedDeps(),
    config: appConfig satisfies AppConfig,
    unitOfWorkProvider: new LibsqlUnitOfWorkProvider(
      config.db,
      SystemClock,
      UuidV7Generator,
      config.relayTrigger,
    ),
  };
}

/** Build the worker-scoped container for the Node runtime. */
export function createNodeWorkerContainer(db: Database): WorkerContainer {
  return {
    ...buildSharedDeps(),
    outboxRepository: new LibsqlOutboxRepository(
      db,
      UuidV7Generator,
      SystemClock,
    ),
    idempotencyStore: new LibsqlIdempotencyStore(db, SystemClock),
  };
}
