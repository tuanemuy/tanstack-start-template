// `node:async_hooks` lives only here (not in `di/serverCloudflare.ts`) so
// the import does not leak into the client bundle through server-fn
// dynamic imports traced by vite.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createRequestContainer,
  readRequestServerConfig,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import { default as defaultEntry } from "@tanstack/react-start/server-entry";

// SSR and RSC are separate module graphs in the same isolate; pin the
// ALS on `globalThis` (and on `import.meta.hot.data` for HMR) so both
// resolve the same store.
const ALS_SYMBOL: unique symbol = Symbol.for(
  "@tanstack-start-template/request-als",
) as never;
type AlsHotData = { als?: AsyncLocalStorage<RequestContainer> };
type AlsGlobalSlot = { [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer> };
const alsHotData: AlsHotData = (import.meta.hot?.data ?? {}) as AlsHotData;
const alsGlobal = globalThis as unknown as AlsGlobalSlot;
const storage =
  alsGlobal[ALS_SYMBOL] ??
  alsHotData.als ??
  new AsyncLocalStorage<RequestContainer>();
alsGlobal[ALS_SYMBOL] = storage;
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
