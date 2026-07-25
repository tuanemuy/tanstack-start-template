// SSR and RSC are separate module graphs but share the same realm, so
// the store handle lives on a `Symbol.for(...)`-keyed slot of
// `globalThis` to keep both envs in sync. No node-only imports here —
// server-fn dynamic imports traverse this module into the client graph.
import type { RequestContainer } from "./types";

export type ContainerStore = Readonly<{
  getStore(): RequestContainer | undefined;
}>;

const STORE_SYMBOL: unique symbol = Symbol.for(
  "@tanstack-start-template/container-store",
) as never;

type GlobalSlot = { [STORE_SYMBOL]?: ContainerStore };

function slot(): GlobalSlot {
  return globalThis as unknown as GlobalSlot;
}

export function installContainerStore(next: ContainerStore): void {
  slot()[STORE_SYMBOL] = next;
}

export function getInstalledStore(): ContainerStore | undefined {
  return slot()[STORE_SYMBOL];
}

/**
 * Resolve the request-scoped container. The store is installed by the
 * runtime entry (`apps/web/app/server.cloudflare.ts` /
 * `apps/web/app/server.node.ts`) at
 * module load; this reader is shared by both runtimes.
 *
 * Returns `Promise<RequestContainer>` so call sites can `await` it
 * symmetrically with other async setup. Throws if the store is not
 * installed or the call is outside a request scope — both indicate a
 * wiring bug, not a recoverable runtime error.
 */
export function getContainer(): Promise<RequestContainer> {
  const store = getInstalledStore();
  if (!store) {
    throw new Error(
      "getContainer() called before the container store was installed. " +
        "The runtime entry (apps/web/app/server.cloudflare.ts or " +
        "apps/web/app/server.node.ts) " +
        "installs the store at module load.",
    );
  }
  const container = store.getStore();
  if (!container) {
    throw new Error(
      "getContainer() called outside a request scope. " +
        "The fetch handler must wrap each request in the AsyncLocalStorage " +
        "scope before invoking framework code.",
    );
  }
  return Promise.resolve(container);
}
