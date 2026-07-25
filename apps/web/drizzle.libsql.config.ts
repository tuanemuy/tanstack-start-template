import { defineConfig } from "drizzle-kit";

// drizzle-kit only generates SQL here; application runs through
// `scripts/migrate.node.ts` so credential wiring stays in one place.
export default defineConfig({
  out: "../../packages/core/src/adapters/libsql/migrations",
  schema: "../../packages/core/src/adapters/libsql/schema.ts",
  dialect: "sqlite",
});
