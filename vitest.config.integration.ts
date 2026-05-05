import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// D1 integration tests run inside a Workers isolate (Miniflare) with a
// real `env.DB` D1 binding backed by an in-memory SQLite database. The
// libSQL-based integration tests under `app/core/adapters/drizzleSqlite`
// continue to run via the existing `vitest.config.ts` and are excluded
// here.
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
        bindings: {
          MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["app/core/adapters/d1/**/*.integration.test.ts"],
    setupFiles: ["app/core/adapters/d1/__tests__/setup.ts"],
  },
});
