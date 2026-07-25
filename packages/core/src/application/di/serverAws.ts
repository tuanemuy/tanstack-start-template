// Deliberately separate from `./serverNode.ts` and `./serverCloudflare.ts`
// so the AWS entry never pulls Workers-only imports and the Node entry
// never pulls AWS-SDK imports. All three factories return the same
// `RequestContainer` / `WorkerContainer` shapes.

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
 * AWS-side env shape. `DATABASE_URL` follows the libSQL URL grammar
 * (`libsql:` for remote Turso, `file:` only useful for local testing).
 *
 * Per-Lambda variables (`EVENTS_QUEUE_URL`, `RELAY_FUNCTION_NAME`) are
 * declared here so a single env reader covers every Lambda role; readers
 * that don't need a given var simply ignore it.
 */
export type AwsServerEnv = Readonly<{
  DATABASE_URL: string;
  DATABASE_AUTH_TOKEN?: string | undefined;
  APP_URL: string;
  AWS_REGION?: string | undefined;
  EVENTS_QUEUE_URL?: string | undefined;
  RELAY_FUNCTION_NAME?: string | undefined;
  OUTBOX_BATCH_SIZE?: string | undefined;
  OUTBOX_LEASE_MS?: string | undefined;
  OUTBOX_MAX_ATTEMPTS?: string | undefined;
  OUTBOX_RETENTION_MS?: string | undefined;
}>;

const awsServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  APP_URL: z.string().min(1, "APP_URL is required"),
  AWS_REGION: z.string().min(1).optional(),
  EVENTS_QUEUE_URL: z.string().min(1).optional(),
  RELAY_FUNCTION_NAME: z.string().min(1).optional(),
  OUTBOX_BATCH_SIZE: z.string().optional(),
  OUTBOX_LEASE_MS: z.string().optional(),
  OUTBOX_MAX_ATTEMPTS: z.string().optional(),
  OUTBOX_RETENTION_MS: z.string().optional(),
});

/**
 * Validates `process.env`-shaped input against the AWS-runtime surface.
 */
export function readAwsServerEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): AwsServerEnv {
  return awsServerEnvSchema.parse(source);
}

/** Projection of {@link AwsServerEnv} to the runtime-agnostic tuning shape. */
export function awsServerEnvToTuningEnv(env: AwsServerEnv): TuningEnv {
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

export function readRelayTuning(env: AwsServerEnv): RelayTuning {
  return readRelayTuningShared(awsServerEnvToTuningEnv(env));
}

export function readPruneTuning(env: AwsServerEnv): PruneTuning {
  return readPruneTuningShared(awsServerEnvToTuningEnv(env));
}

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/**
 * Request-path config. `db` and `relayTrigger` are resolved once at cold
 * start and reused across invocations (no per-request binding like CF's
 * D1).
 */
export type AwsRequestServerConfig = AppConfig &
  Readonly<{
    db: Database;
    relayTrigger: RelayTrigger;
  }>;

export function readAwsRequestServerConfig(
  env: AwsServerEnv,
  bindings: { db: Database; relayTrigger?: RelayTrigger },
): AwsRequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    db: bindings.db,
    relayTrigger: bindings.relayTrigger ?? NoopRelayTrigger,
  };
}

/** Build the request-scoped container for the AWS runtime. */
export function createAwsRequestContainer(
  config: AwsRequestServerConfig,
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

/** Build the worker-scoped container for the AWS runtime. */
export function createAwsWorkerContainer(db: Database): WorkerContainer {
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
