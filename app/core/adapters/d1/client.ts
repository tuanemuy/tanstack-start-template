import type { D1Database } from "@cloudflare/workers-types";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Wraps a D1 binding into a Drizzle handle pre-bound to the project schema.
 *
 * The D1 adapter is intentionally unrelated to the libSQL `client.ts`: D1
 * exposes a callable binding object, not a connection URL, and there is no
 * journal-mode setup to wait on. Callers obtain the binding from the
 * Workers `env` (production / wrangler) or `cloudflare:test` (vitest pool).
 */
export function getDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}
