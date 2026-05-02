import type { z } from "zod";
import type { Container } from "@/core/application/di/types";
import { defineServerFn } from "./serverFn";
import { validateInput } from "./validator";

type ServerActionMethod = "GET" | "POST";

async function loadServerDeps<TModule>(
  loadModule: () => Promise<TModule>,
): Promise<{ container: Container; module: TModule }> {
  const [{ getContainer }, module] = await Promise.all([
    import("@/core/application/di/server"),
    loadModule(),
  ]);
  return { container: await getContainer(), module };
}

/**
 * Loads server-only DI + a module dependency in parallel and runs the
 * user-supplied callback. Used by RSC components and other server-side data
 * loaders that don't go through the server-fn boundary.
 *
 * The dynamic `import(...)` is the boundary that keeps the server adapter
 * graph out of the client static graph — the framework strips server-fn
 * handler bodies but doesn't tree-shake top-level static imports of
 * side-effectful modules.
 */
export function serverData<TModule, TResult>(
  loadModule: () => Promise<TModule>,
  run: (ctx: { container: Container }, module: TModule) => Promise<TResult>,
): () => Promise<TResult> {
  return async () => {
    const { container, module } = await loadServerDeps(loadModule);
    return run({ container }, module);
  };
}

/**
 * Canonical entry point for usecase-backed server actions. Bundles input
 * validation, server-only deps loading, container injection, and server-fn
 * binding so each handler is a single expression.
 */
export function serverAction<TSchema extends z.ZodType, TModule, TResult>(
  schema: TSchema,
  loadModule: () => Promise<TModule>,
  handler: (
    ctx: { data: z.infer<TSchema>; container: Container },
    module: TModule,
  ) => Promise<TResult>,
  options?: { method?: ServerActionMethod },
) {
  return defineServerFn(options ?? { method: "POST" })
    .inputValidator(validateInput(schema))
    .handler(
      // The chain's `ServerFnReturnType` constraint can't be expressed
      // through a generic `TResult`; user-side handler signatures keep the
      // concrete type intact at each call site.
      // biome-ignore lint/suspicious/noExplicitAny: see comment above
      (async ({ data }: { data: z.infer<TSchema> }): Promise<any> => {
        const { container, module } = await loadServerDeps(loadModule);
        return handler({ data, container }, module);
      }) as never,
    );
}
