/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, which for this
// app comes from the generated `worker-configuration.d.ts`. Only the
// test-harness-injected `MIGRATIONS` binding needs declaring here — it
// is provided by `vitest.config.integration.ts` via `miniflare.bindings`
// and never lands in the `wrangler types` output.
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      MIGRATIONS: D1Migration[];
    }
  }
}
