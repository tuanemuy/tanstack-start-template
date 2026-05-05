import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) with a
// real `env.DB` D1 binding backed by an in-memory SQLite database.
// Anything matching `*.integration.test.ts` is included; pure unit
// tests run via the Node-pool `vitest.config.ts` instead.
const migrationsPath = path.join(
  import.meta.dirname,
  "app/core/adapters/d1/migrations",
);

const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        queueProducers: { EVENTS_QUEUE: "tanstack-start-template-events" },
        bindings: {
          MIGRATIONS: migrations,
          APP_URL: "http://localhost:8787",
        },
      },
    }),
  ],
  test: {
    include: ["app/**/*.integration.test.ts"],
    setupFiles: ["app/core/adapters/d1/__tests__/setup.ts"],
  },
});
