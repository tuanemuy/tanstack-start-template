import type { z } from "zod";
import type { RequestContainer } from "@/core/application/di/types";
import { defineServerFn } from "./serverFn";
import { validateInput } from "./validator";

type ServerActionMethod = "GET" | "POST";

async function loadServerDeps<TModule>(
  loadModule: () => Promise<TModule>,
): Promise<{ container: RequestContainer; module: TModule }> {
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

export type WrappedHandler<TSchema extends z.ZodType, TResult> = (input: {
  data: z.infer<TSchema>;
}) => Promise<TResult>;

/**
 * Canonical entry point for usecase-backed server actions. Bundles input
 * validation, server-only deps loading, container injection, and server-fn
 * binding so each handler is a single expression.
 */
export function serverAction<TSchema extends z.ZodType, TModule, TResult>(
  schema: TSchema,
  loadModule: () => Promise<TModule>,
  handler: (
    ctx: { data: z.infer<TSchema>; container: RequestContainer },
    module: TModule,
  ) => Promise<TResult>,
  options?: { method?: ServerActionMethod },
): WrappedHandler<TSchema, TResult> {
  // The chain's `.handler` constraint can't thread a generic `TResult`;
  // cast through `never` and re-narrow at the boundary.
  return defineServerFn({ method: options?.method ?? "POST" })
    .inputValidator(validateInput(schema))
    .handler((async ({ data }: { data: z.infer<TSchema> }) => {
      const { container, module } = await loadServerDeps(loadModule);
      return handler({ data, container }, module);
    }) as never) as unknown as WrappedHandler<TSchema, TResult>;
}
