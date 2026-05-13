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
// The `AsyncLocalStorage` instance is pinned via `import.meta.hot
// .data` so dev HMR re-evaluations of this module reuse the same ALS.
// Otherwise `storage.run()` (new ALS) and the handle captured by
// `getContainer()` (old ALS) would diverge after HMR and every
// request would throw "called outside a request scope". Module-scoped
// HMR data — unlike `globalThis` — is not reachable from other
// tenants in shared-isolate deployments.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { default as defaultEntry } from "@tanstack/react-start/server-entry";
import { installContainerStore } from "@/core/application/di/containerStore";
import {
  createRequestContainer,
  readRequestServerConfig,
  type ServerEnv,
} from "@/core/application/di/server";
import type { RequestContainer } from "@/core/application/di/types";

type AlsHotData = { als?: AsyncLocalStorage<RequestContainer> };
const alsHotData: AlsHotData = (import.meta.hot?.data ?? {}) as AlsHotData;
const storage = alsHotData.als ?? new AsyncLocalStorage<RequestContainer>();
if (import.meta.hot) {
  (import.meta.hot.data as AlsHotData).als = storage;
}
installContainerStore({ getStore: () => storage.getStore() });

export type AppEnv = ServerEnv;

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const container = createRequestContainer(readRequestServerConfig(env, ctx));
    return storage.run(container, async () => defaultEntry.fetch(request));
  },
};
