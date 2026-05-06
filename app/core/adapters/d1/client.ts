import type { D1Database } from "@cloudflare/workers-types";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Wraps a D1 binding into a Drizzle handle pre-bound to the project
 * schema. Callers obtain the binding from the Workers `env`
 * (production / wrangler) or `cloudflare:test` (vitest pool).
 */
export function getDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}
