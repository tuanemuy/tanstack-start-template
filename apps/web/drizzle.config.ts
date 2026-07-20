import { defineConfig } from "drizzle-kit";

// drizzle-kit is used only to *generate* SQL migration files from
// the Drizzle schema. Migration application happens via wrangler
// (`pnpm db:apply:local` / `pnpm db:apply:remote`), not drizzle-kit,
// because D1's actual database lives in Cloudflare's managed
// infrastructure and is reached through the `wrangler d1` CLI rather
// than a connection URL.
// `driver: 'd1-http'` is intentionally omitted to keep wrangler as the single migration-application route (drizzle-kit push would bypass the wrangler ledger).
export default defineConfig({
  out: "../../packages/core/src/adapters/d1/migrations",
  schema: "../../packages/core/src/adapters/d1/schema.ts",
  dialect: "sqlite",
});
