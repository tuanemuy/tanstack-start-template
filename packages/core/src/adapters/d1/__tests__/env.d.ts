/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, so augmenting
// that namespace is what extends the binding shape inside tests.
//
// The bindings are declared here rather than consumed from the app's
// `wrangler types` output (`worker-configuration.d.ts`): that file is a
// generated artifact of the web app and this package must typecheck on
// its own. The shapes mirror `vitest.config.integration.ts` (miniflare
// bindings) plus the D1 / queue bindings the adapter tests exercise.
// `MIGRATIONS` in particular is injected via `miniflare.bindings`, not
// by `wrangler.toml`, so it never lands in generated types anywhere.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      EVENTS_QUEUE?: Queue;
      RELAY?: Fetcher;
      APP_URL: string;
      OUTBOX_BATCH_SIZE?: string;
      OUTBOX_LEASE_MS?: string;
      OUTBOX_MAX_ATTEMPTS?: string;
      OUTBOX_RETENTION_MS?: string;
      MIGRATIONS: D1Migration[];
    }
  }
}
