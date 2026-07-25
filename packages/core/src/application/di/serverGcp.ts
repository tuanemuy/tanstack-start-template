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
import {
  type PruneTuning,
  type RelayTuning,
  readPruneTuning as readPruneTuningShared,
  readRelayTuning as readRelayTuningShared,
  type TuningEnv,
} from "./env";
import type {
  AppConfig,
  RequestContainer,
  SharedDeps,
  WorkerContainer,
} from "./types";

/**
 * GCP-side env shape. Per-service variables (`EVENTS_TOPIC`, `RELAY_URL`,
 * `GCP_PROJECT_ID`) are declared on the union so a single reader covers
 * every Cloud Run role.
 */
export type GcpServerEnv = Readonly<{
  DATABASE_URL: string;
  DATABASE_AUTH_TOKEN?: string | undefined;
  APP_URL: string;
  GCP_PROJECT_ID?: string | undefined;
  EVENTS_TOPIC?: string | undefined;
  RELAY_URL?: string | undefined;
  OUTBOX_BATCH_SIZE?: string | undefined;
  OUTBOX_LEASE_MS?: string | undefined;
  OUTBOX_MAX_ATTEMPTS?: string | undefined;
  OUTBOX_RETENTION_MS?: string | undefined;
}>;

const gcpServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  APP_URL: z.string().min(1, "APP_URL is required"),
  GCP_PROJECT_ID: z.string().min(1).optional(),
  EVENTS_TOPIC: z.string().min(1).optional(),
  RELAY_URL: z.string().min(1).optional(),
  OUTBOX_BATCH_SIZE: z.string().optional(),
  OUTBOX_LEASE_MS: z.string().optional(),
  OUTBOX_MAX_ATTEMPTS: z.string().optional(),
  OUTBOX_RETENTION_MS: z.string().optional(),
});

export function readGcpServerEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): GcpServerEnv {
  return gcpServerEnvSchema.parse(source);
}

export function gcpServerEnvToTuningEnv(env: GcpServerEnv): TuningEnv {
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

export function readRelayTuning(env: GcpServerEnv): RelayTuning {
  return readRelayTuningShared(gcpServerEnvToTuningEnv(env));
}

export function readPruneTuning(env: GcpServerEnv): PruneTuning {
  return readPruneTuningShared(gcpServerEnvToTuningEnv(env));
}

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

export type GcpRequestServerConfig = AppConfig &
  Readonly<{
    db: Database;
    relayTrigger: RelayTrigger;
  }>;

export function readGcpRequestServerConfig(
  env: GcpServerEnv,
  bindings: { db: Database; relayTrigger?: RelayTrigger },
): GcpRequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    db: bindings.db,
    relayTrigger: bindings.relayTrigger ?? NoopRelayTrigger,
  };
}

export function createGcpRequestContainer(
  config: GcpRequestServerConfig,
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

export function createGcpWorkerContainer(db: Database): WorkerContainer {
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
