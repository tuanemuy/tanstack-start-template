/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `TODO_STATE` is provided by `vitest.config.integration.ts` via
// `miniflare.durableObjects` (backed by the class exported from the
// pool's `main` module), so it never appears in the `wrangler types`
// output that populates `Cloudflare.Env` for this app.
import type { TodoStateObject } from "../../../durable-objects/todoState";

declare global {
  namespace Cloudflare {
    interface Env {
      TODO_STATE: DurableObjectNamespace<TodoStateObject>;
    }
  }
}
