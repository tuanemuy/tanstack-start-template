import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.SQLITE_URL;

if (!url) {
  throw new Error("SQLITE_URL environment variable is not set.");
}

export default defineConfig({
  out: "./app/core/adapters/drizzleSqlite/migrations",
  schema: "./app/core/adapters/drizzleSqlite/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url,
  },
});
