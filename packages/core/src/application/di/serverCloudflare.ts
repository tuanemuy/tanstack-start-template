// Deliberately separate from `./serverNode.ts` so the Node entry never
// pulls Workers-only imports and vice versa. Both factories return the
// same `RequestContainer` / `WorkerContainer` shapes.
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { ServiceBindingRelayTrigger } from "@repo/core/adapters/cloudflare/serviceBindingRelayTrigger";
import { getDatabase } from "@repo/core/adapters/d1/client";
import { D1IdempotencyStore } from "@repo/core/adapters/d1/repositories/idempotencyStore";
import { D1OutboxRepository } from "@repo/core/adapters/d1/repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "@repo/core/adapters/d1/unitOfWork";
import { content } from "@repo/core/config";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { NoopRelayTrigger, type RelayTrigger } from "../ports/relayTrigger";
import type { TuningEnv } from "./env";
import {
  type PruneTuning,
  type RelayTuning,
  readPruneTuning as readPruneTuningShared,
  readRelayTuning as readRelayTuningShared,
} from "./env";
import type {
  AppConfig,
  RequestContainer,
  SharedDeps,
  WorkerContainer,
} from "./types";

export {
  type ContainerStore,
  installContainerStore,
} from "./containerStore";
export type {
  AppConfig,
  RequestContainer,
  SharedDeps,
  WorkerContainer,
} from "./types";

/**
 * Request-path config: extends `AppConfig` (SSR head/meta) with the
 * runtime bindings the request container needs to construct its UoW.
 */
export type RequestServerConfig = AppConfig &
  Readonly<{
    binding: D1Database;
    // Service Binding to the relay Worker — present on the request
    // path. Workers (relay / consumer / pruner / dlq) build their own
    // container without this binding and never kick the relay.
    relay?: Fetcher;
    // `ExecutionContext.waitUntil` bridge so the kicker can outlive
    // the originating request. Required when `relay` is set; ignored
    // otherwise.
    waitUntil?: (promise: Promise<unknown>) => void;
  }>;

/**
 * Cloudflare bindings shape. The `OUTBOX_*` vars are runtime-agnostic
 * (see {@link TuningEnv}); the D1/Fetcher bindings are CF-only. The
 * Node entry has its own env shape in `./serverNode`.
 */
export type ServerEnv = Readonly<{
  DB: D1Database;
  APP_URL: string;
  RELAY?: Fetcher;
  // Worker tuning knobs. Wrangler `[vars]` deliver strings — parse +
  // default via `readRelayTuning` / `readPruneTuning` at the worker
  // entry boundary. Missing values fall back to the application-layer
  // defaults exported from the worker modules.
  OUTBOX_BATCH_SIZE?: string;
  OUTBOX_LEASE_MS?: string;
  OUTBOX_MAX_ATTEMPTS?: string;
  OUTBOX_RETENTION_MS?: string;
}>;

export type { PruneTuning, RelayTuning } from "./env";

// Re-export the shared readers under the original names so wrangler
// worker entries that import from this module keep working unchanged.
// `ServerEnv` is structurally compatible with `TuningEnv`, so passing
// it directly satisfies the shared reader's input contract.
export function readRelayTuning(env: ServerEnv): RelayTuning {
  return readRelayTuningShared(env as TuningEnv);
}

export function readPruneTuning(env: ServerEnv): PruneTuning {
  return readPruneTuningShared(env as TuningEnv);
}

export function readRequestServerConfig(
  env: ServerEnv,
  // Only the request path supplies a context — workers omit this.
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): RequestServerConfig {
  // `exactOptionalPropertyTypes` forbids `relay: undefined`, so build
  // the optional pair conditionally instead of always spreading them.
  return {
    ...content,
    appUrl: env.APP_URL,
    binding: env.DB,
    ...(env.RELAY ? { relay: env.RELAY } : {}),
    ...(ctx
      ? {
          waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
        }
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
 * Build the request-scoped container. Wires the unit-of-work
 * provider with a relay trigger (Service Binding when available,
 * no-op otherwise), and exposes `config` for SSR head/meta.
 */
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const db = getDatabase(config.binding);
  const { binding: _binding, relay, waitUntil, ...appConfig } = config;
  const relayTrigger: RelayTrigger =
    relay && waitUntil
      ? new ServiceBindingRelayTrigger(relay, waitUntil, ConsoleLogger)
      : NoopRelayTrigger;
  return {
    ...buildSharedDeps(),
    config: appConfig satisfies AppConfig,
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
      relayTrigger,
    ),
  };
}

/**
 * Build the worker-scoped container. Workers don't render HTML
 * (no `config`) and don't mutate aggregates (no `unitOfWorkProvider`)
 * — they read/write the outbox directly and stamp idempotency keys.
 */
export function createWorkerContainer(env: ServerEnv): WorkerContainer {
  const db = getDatabase(env.DB);
  return {
    ...buildSharedDeps(),
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator, SystemClock),
    idempotencyStore: new D1IdempotencyStore(db, SystemClock),
  };
}
