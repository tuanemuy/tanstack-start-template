// Module-scoped registry for the request-scoped container handle.
//
// Replaces the previous `globalThis.__APP_CONTAINER_STORE__` pin. A
// module-level `let` is private to this module, so shared-isolate
// deployments (Workers for Platforms, preview branches) cannot reach
// the handle from another tenant's code via `globalThis`.
//
// `app/server.ts` calls `installContainerStore` at Worker boot,
// passing an `AsyncLocalStorage`-backed reader. Server-side code
// (presentation, RSC) reads the handle through `getInstalledStore`.
//
// `import.meta.hot.data` survival keeps the install across dev HMR
// re-evaluation so in-flight requests don't lose their reader
// mid-flight. In production builds Vite tree-shakes the `import.meta
// .hot` branch entirely.
//
// Crucially this module imports nothing Node-only — `node:async_hooks`
// stays in `app/server.ts`. Server-fn dynamic imports of
// `app/core/application/di/server.ts` traverse here transitively, and
// Vite's client build must be able to resolve every node in that
// graph.
import type { RequestContainer } from "./types";

export type ContainerStore = Readonly<{
  getStore(): RequestContainer | undefined;
}>;

type HotData = { store?: ContainerStore };

const hotData: HotData = (import.meta.hot?.data ?? {}) as HotData;

let store: ContainerStore | undefined = hotData.store;

export function installContainerStore(next: ContainerStore): void {
  store = next;
  if (import.meta.hot) {
    (import.meta.hot.data as HotData).store = next;
  }
}

export function getInstalledStore(): ContainerStore | undefined {
  return store;
}
