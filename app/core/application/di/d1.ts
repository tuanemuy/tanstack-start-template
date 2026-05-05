// Workers-only. The D1 binding is only available inside a Workers
// runtime, so this module is imported by the Workers entrypoint
// (e.g. `wrangler.toml` `main`) and never reaches the Node-server
// graph. The libSQL container in `./server.ts` is its sibling for
// the Node deployment; the two never coexist in one runtime.
import type { D1Database } from "@cloudflare/workers-types";
import { content } from "@/config";
import { getDatabase } from "@/core/adapters/d1/client";
import { D1OutboxRepository } from "@/core/adapters/d1/repositories/outboxRepository";
import { D1UnitOfWorkProvider } from "@/core/adapters/d1/unitOfWork";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { AppConfig, Container } from "./types";

export type { AppConfig, Container } from "./types";

/**
 * Server-side configuration assembled from a Workers `env`. Parallel to
 * `ServerConfig` in `./server.ts`, but addresses the database via a
 * binding rather than a connection URL.
 */
export type D1ServerConfig = AppConfig &
  Readonly<{
    binding: D1Database;
  }>;

export type D1Env = Readonly<{
  DB: D1Database;
  APP_URL: string;
}>;

export function readD1ServerConfig(env: D1Env): D1ServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    binding: env.DB,
  };
}

/**
 * Build a D1-backed container.
 *
 * No process-wide singleton: Workers isolates are per-request and the
 * `env` binding is a request-scoped argument, so each handler invocation
 * constructs a fresh container. Stateless ports (`clock`, `idGenerator`,
 * `logger`) are the same instances the libSQL container uses; they live
 * outside the per-request hot path because they hold no mutable state.
 */
export function createD1Container(config: D1ServerConfig): Container {
  const db = getDatabase(config.binding);
  const { binding: _binding, ...appConfig } = config;
  return {
    config: appConfig satisfies AppConfig,
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    // Relay-side outbox repo (no `PendingBatch`). The UoW constructs its
    // own per-run buffered instance internally.
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      // The D1 binding's lifecycle is owned by the Workers runtime;
      // there is nothing to close. Kept as a no-op so the `Container`
      // shape is uniform across environments and callers can `await
      // container.shutdown()` regardless of the deployment target.
    },
  };
}
