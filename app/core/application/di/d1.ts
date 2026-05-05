// D1 DI module. Imported from both:
//
//   - server-side code (Worker entries, presentation server functions,
//     RSC components) for `getContainer()` and the container factories;
//   - the client static graph indirectly, when a server-fn module
//     declares `await import("@/core/application/di/d1")` inside a
//     handler body. Vite traces those chunks during the client build,
//     so this module MUST stay free of Node-only imports
//     (`node:async_hooks`, `node:fs`, …).
//
// The `runWithContainer` half — which pulls in
// `node:async_hooks` — lives in `app/server/container.ts` and is only
// ever imported from Worker entries. `getContainer()` here reads from
// a `globalThis`-installed handle that the server file populates.
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
    outboxRepository: new D1OutboxRepository(db, UuidV7Generator),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    shutdown: async () => {
      // The D1 binding's lifecycle is owned by the Workers runtime;
      // there is nothing to close. Kept as a no-op so the `Container`
      // shape is uniform across environments.
    },
  };
}

/**
 * Server-side container handle exposed to this module via
 * `globalThis`. The Worker entry installs the handle (an
 * `AsyncLocalStorage`-backed reader) when it loads, before any
 * request runs. Tests do not use this path — they call
 * `createTestContainer()` directly.
 *
 * The handle is the *only* coupling between the request boundary and
 * the presentation layer: keeping it shaped as a minimal `getStore()`
 * function lets `app/server/container.ts` own the `node:async_hooks`
 * import without leaking it into the client graph.
 */
export type ContainerStore = Readonly<{
  getStore(): Container | undefined;
}>;

declare global {
  var __APP_CONTAINER_STORE__: ContainerStore | undefined;
}

export function installContainerStore(store: ContainerStore): void {
  globalThis.__APP_CONTAINER_STORE__ = store;
}

/**
 * Resolve the request-scoped container.
 *
 * Returns `Promise<Container>` so presentation-layer call sites that
 * use `await getContainer()` keep working unchanged. Throws if called
 * outside a request scope or before the Worker entry installed the
 * store — both indicate a wiring bug rather than a recoverable
 * runtime error.
 */
export function getContainer(): Promise<Container> {
  const store = globalThis.__APP_CONTAINER_STORE__;
  if (!store) {
    throw new Error(
      "getContainer() called before the container store was installed. " +
        "Worker entries must import from @/server/container so the store " +
        "is registered on globalThis before the handler runs.",
    );
  }
  const container = store.getStore();
  if (!container) {
    throw new Error(
      "getContainer() called outside a runWithContainer scope. " +
        "Wrap the Worker fetch handler with runWithContainer(env, () => …) " +
        "before invoking framework code that resolves the container.",
    );
  }
  return Promise.resolve(container);
}
