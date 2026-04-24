import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    // Give integration tests more headroom for file-based SQLite setup
    // (temp file creation + migrations + WAL pragma + cleanup) plus the
    // RetryingUnitOfWorkProvider's exponential backoff which can stack up
    // to ~4s across retries under contention. Unit tests (fakes, domain
    // logic, property-based) complete well under 5s; this ceiling only
    // matters for `*.integration.test.ts`.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
