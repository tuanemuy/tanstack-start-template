import { defineConfig } from "vitest/config";

// Node-pool config for unit tests (domain logic, fakes, property-based,
// pure usecases). Anything that needs a real D1 binding lives in
// `*.integration.test.ts` and runs through `vitest.config.integration.ts`
// (the `vitest-pool-workers` Workers pool).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.direnv/**",
      "**/*.integration.test.ts",
      "spec/**",
    ],
  },
});
