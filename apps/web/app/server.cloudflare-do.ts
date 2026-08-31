// Entry for the Durable-Object-based Cloudflare runtime. Same shape as
// `server.cloudflare.ts` (see the ALS rationale there); the swap is the
// DI wiring: the unit of work talks to the todo-state DO instead of D1,
// and there is no relay Service Binding — the DO arms its own alarm.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  DurableObjectNamespace,
  ExecutionContext,
} from "@cloudflare/workers-types";
import {
  DEFAULT_TODO_SCOPE,
  type TodoStateClient,
} from "@repo/core/adapters/do/protocol";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createDoRequestContainer,
  readDoRequestServerConfig,
} from "@repo/core/application/di/serverCloudflareDo";
import type { RequestContainer } from "@repo/core/application/di/types";
import { default as defaultEntry } from "@tanstack/react-start/server-entry";
import { TodoStateObject } from "./durable-objects/todoState";

// wrangler resolves DO classes against the main module's exports.
export { TodoStateObject };

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

export type AppEnv = Readonly<{
  APP_URL: string;
  TODO_STATE: DurableObjectNamespace;
}>;

// The stub's RPC methods mirror `TodoStateClient` by construction (the
// DO class implements that surface), but the platform types wrap each
// return in RPC promise/stub machinery that TS cannot relate back to
// the structural interface — hence the single widening cast here, at
// the only place a stub is minted.
function todoStateClient(env: AppEnv): TodoStateClient {
  const stub = env.TODO_STATE.get(
    env.TODO_STATE.idFromName(DEFAULT_TODO_SCOPE),
  );
  return stub as unknown as TodoStateClient;
}

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const container = createDoRequestContainer(
      readDoRequestServerConfig(env, todoStateClient(env)),
    );
    return storage.run(container, async () => defaultEntry.fetch(request));
  },
};
