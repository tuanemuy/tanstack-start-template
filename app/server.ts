// TanStack Start custom server entry — the file Vite's
// `tanstackStart` plugin resolves to when building the SSR bundle.
// Replaces the framework's default entry so we can wrap each request
// with `runWithContainer(env, …)`, establishing the request-scoped DI
// container that `getContainer()` reads through.
//
// This is the *only* place `node:async_hooks` is imported on the main
// app side: keeping it out of `app/core/application/di/server.ts`
// prevents the AsyncLocalStorage import from leaking into the client
// bundle when server-fn dynamic imports are traced.
//
// The `AsyncLocalStorage` instance itself is pinned on `globalThis`
// so that dev HMR re-evaluations of this module reuse the same ALS.
// Otherwise `storage.run()` (new ALS) and the handle captured by
// `getContainer()` (old ALS) would diverge after HMR and every
// request would throw "called outside a request scope".
import { AsyncLocalStorage } from "node:async_hooks";
import { default as defaultEntry } from "@tanstack/react-start/server-entry";
import {
  createContainer,
  installContainerStore,
  readServerConfig,
  type ServerEnv,
} from "@/core/application/di/server";
import type { Container } from "@/core/application/di/types";

declare global {
  var __APP_ALS__: AsyncLocalStorage<Container> | undefined;
}

const storage = globalThis.__APP_ALS__ ?? new AsyncLocalStorage<Container>();
globalThis.__APP_ALS__ = storage;
installContainerStore({ getStore: () => storage.getStore() });

export type AppEnv = ServerEnv;

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const container = createContainer(readServerConfig(env));
    return storage.run(container, async () => defaultEntry.fetch(request));
  },
};
