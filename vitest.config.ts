import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    // Give integration tests headroom for in-memory SQLite setup
    // (migration apply + connection close) plus the Drizzle adapter's
    // internal transient retry, which can stack exponential backoff up to
    // ~4s under contention. Unit tests (fakes, domain logic,
    // property-based) complete well under 5s; this ceiling only matters
    // for `*.integration.test.ts`.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // The D1 adapter has its own integration suite that runs inside a
    // Workers isolate via `vitest.config.integration.ts` (`pnpm test:d1`).
    // Excluded here because Node-pool execution cannot resolve
    // `cloudflare:test`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "app/core/adapters/d1/**",
      "app/worker/**",
    ],
  },
});
