import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) with a
// real `env.DB` D1 binding backed by an in-memory SQLite database.
// Anything matching `*.integration.test.ts` is included; pure unit
// tests run via the Node-pool `vitest.config.ts` instead.
const migrationsPath = path.join(
  import.meta.dirname,
  "packages/core/src/adapters/d1/migrations",
);

const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        queueProducers: {
          EVENTS_QUEUE: "tanstack-start-template-events",
          // Registered so `createMessageBatch("…-events-dlq", …)` is
          // recognised by the test harness when exercising the DLQ
          // consumer; the production DLQ Worker does not bind it as a
          // producer.
          EVENTS_DLQ: "tanstack-start-template-events-dlq",
        },
        // Mirror wrangler.toml so the DLQ routing wiring is the same
        // shape miniflare sees in production. Tests that go through
        // `createMessageBatch(...)` bypass dispatch and don't depend on
        // these values, but registering them keeps the per-batch
        // disposition (`retryBatch.retry`) consistent with how real
        // queues would surface the same handler decision, and prevents
        // silent drift when wrangler.toml is tuned.
        queueConsumers: {
          "tanstack-start-template-events": {
            maxBatchSize: 25,
            maxBatchTimeout: 30,
            maxRetries: 3,
            deadLetterQueue: "tanstack-start-template-events-dlq",
          },
          "tanstack-start-template-events-dlq": {
            maxBatchSize: 25,
            maxBatchTimeout: 30,
            maxRetries: 1,
          },
        },
        bindings: {
          MIGRATIONS: migrations,
          APP_URL: "http://localhost:8787",
        },
      },
    }),
  ],
  test: {
    include: [
      "apps/web/app/worker/cloudflare/**/*.integration.test.ts",
      "packages/core/src/adapters/d1/**/*.integration.test.ts",
      "packages/core/src/application/**/*.integration.test.ts",
    ],
    // The libSQL adapter and the in-process worker runner have their
    // own Node-pool integration tests (`vitest.config.integration.node.ts`).
    // They share the `*.integration.test.ts` suffix with the D1 tests
    // but cannot run inside Miniflare — `@libsql/client` requires the
    // Node `libsql` native module, which is not available in the
    // Workers pool. Exclude those subtrees here.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.direnv/**",
      "packages/core/src/adapters/libsql/**",
      "packages/core/src/adapters/node/**",
      "apps/web/app/worker/node/**",
    ],
    setupFiles: ["packages/core/src/adapters/d1/__tests__/setup.ts"],
  },
});
