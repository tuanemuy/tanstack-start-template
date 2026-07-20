import { getContainer } from "@repo/core/application/di/containerStore";
import type { RequestContainer } from "@repo/core/application/di/types";

/**
 * Loads the DI container + a usecase module in parallel. The module
 * stays dynamic so the server adapter graph it pulls in doesn't leak
 * into the client bundle (the framework strips handler bodies but not
 * static top-level imports).
 */
export async function loadServerDeps<TModule>(
  loadModule: () => Promise<TModule>,
): Promise<{ container: RequestContainer; module: TModule }> {
  const [container, module] = await Promise.all([getContainer(), loadModule()]);
  return { container, module };
}

/**
 * Server-side data loader for RSC components (not a server-fn factory —
 * server functions must declare their `.handler(...)` chain inline so
 * the TanStack Start compiler can rewrite it into an RPC stub).
 */
export function serverData<
  TModule,
  TResult,
  TArgs extends readonly unknown[] = [],
>(
  loadModule: () => Promise<TModule>,
  run: (
    ctx: { container: RequestContainer },
    module: TModule,
    ...args: TArgs
  ) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    const { container, module } = await loadServerDeps(loadModule);
    return run({ container }, module, ...args);
  };
}
