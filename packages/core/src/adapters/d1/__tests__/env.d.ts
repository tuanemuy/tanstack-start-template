/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, so augmenting
// that namespace is what extends the binding shape inside tests. The
// `MIGRATIONS` binding is injected by `vitest.config.integration.ts`
// via `miniflare.bindings`, not by `wrangler.toml`, so it never lands
// in the `wrangler types` output and must be declared here.
declare global {
  namespace Cloudflare {
    interface Env {
      MIGRATIONS: D1Migration[];
    }
  }
}
