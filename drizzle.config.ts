import { defineConfig } from "drizzle-kit";

// drizzle-kit is used only to *generate* SQL migration files from
// the Drizzle schema. Migration application happens via wrangler
// (`pnpm db:apply:local` / `pnpm db:apply:remote`), not drizzle-kit,
// because D1's actual database lives in Cloudflare's managed
// infrastructure and is reached through the `wrangler d1` CLI rather
// than a connection URL.
export default defineConfig({
  out: "./app/core/adapters/d1/migrations",
  schema: "./app/core/adapters/d1/schema.ts",
  dialect: "sqlite",
});
