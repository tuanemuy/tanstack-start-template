// Server-side DI module. Imported from both:
//
//   - server-side code (the TanStack Start server entry, presentation
//     server functions, RSC components) for `getContainer()` and the
//     container factories;
//   - the client static graph indirectly, when a server-fn module
//     declares `await import("@/core/application/di/server")` inside
//     a handler body. Vite traces those chunks during the client
//     build, so this module MUST stay free of Node-only imports
//     (`node:async_hooks`, `node:fs`, …).
//
// The `AsyncLocalStorage`-backed half lives in `app/server.ts` (the
// Worker entry); it `installContainerStore`s a handle that
// `getContainer()` here reads through. The split keeps node-only
// imports out of any chunk reachable from the client graph.
//
// The module is named for its *role* (server-side container wiring),
// not for the adapter it currently wires (D1). Swapping the adapter
// changes the implementations below; the module identity stays put.
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { z } from "zod";
import { content } from "@/config";
import { ServiceBindingRelayTrigger } from "@/core/adapters/cloudflare/serviceBindingRelayTrigger";
import { getDatabase } from "@/core/adapters/d1/client";
import { D1IdempotencyStore } from "@/core/adapters/d1/repositories/idempotencyStore";
import { D1OutboxRepository } from "@/core/adapters/d1/repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "@/core/adapters/d1/unitOfWork";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { NoopRelayTrigger, type RelayTrigger } from "../ports/relayTrigger";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from "../workers/eventRelayWorker";
import { DEFAULT_OUTBOX_RETENTION_MS } from "../workers/outboxPrune";
import { getInstalledStore } from "./containerStore";
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

// Tuning shapes are deliberately split per-worker: the relay reads
// nothing about retention, and the pruner reads nothing about batch /
// lease. Splitting the readers prevents "this var is unused on this
// worker" confusion when wrangler.toml carries the same env block
// per named environment.
const relayTuningSchema = z.object({
  batchSize: z.coerce.number().int().positive().default(DEFAULT_BATCH_SIZE),
  leaseMs: z.coerce.number().int().positive().default(DEFAULT_LEASE_MS),
  maxAttempts: z.coerce.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
});
const pruneTuningSchema = z.object({
  retentionMs: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_RETENTION_MS),
});

export type RelayTuning = z.infer<typeof relayTuningSchema>;
export type PruneTuning = z.infer<typeof pruneTuningSchema>;

export function readRelayTuning(env: ServerEnv): RelayTuning {
  return relayTuningSchema.parse({
    batchSize: env.OUTBOX_BATCH_SIZE,
    leaseMs: env.OUTBOX_LEASE_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });
}

export function readPruneTuning(env: ServerEnv): PruneTuning {
  return pruneTuningSchema.parse({
    retentionMs: env.OUTBOX_RETENTION_MS,
  });
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

/**
 * Resolve the request-scoped container.
 *
 * The handle (an `AsyncLocalStorage`-backed reader) is installed by
 * the Worker entry at module load via `installContainerStore`; this
 * function reads through the module-scoped store registered there.
 * Tests do not use this path — they call `createTestContainer()`
 * directly.
 *
 * Returns `Promise<RequestContainer>` so presentation-layer call
 * sites that use `await getContainer()` keep working unchanged.
 * Throws if called outside a request scope or before the Worker
 * entry installed the store — both indicate a wiring bug rather
 * than a recoverable runtime error.
 */
export function getContainer(): Promise<RequestContainer> {
  const store = getInstalledStore();
  if (!store) {
    throw new Error(
      "getContainer() called before the container store was installed. " +
        "The Worker entry (app/server.ts) installs the store at module load.",
    );
  }
  const container = store.getStore();
  if (!container) {
    throw new Error(
      "getContainer() called outside a request scope. " +
        "The fetch handler in app/server.ts must wrap each request in " +
        "the AsyncLocalStorage scope before invoking framework code.",
    );
  }
  return Promise.resolve(container);
}
