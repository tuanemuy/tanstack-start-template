import { defineConfig } from "vitest/config";

// Node-pool integration tests for the libSQL adapter + node runner.
// Each test provisions its own temp libSQL file via `createTestContainer()`.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "app/core/adapters/libsql/__tests__/**/*.integration.test.ts",
      "app/core/adapters/node/__tests__/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
