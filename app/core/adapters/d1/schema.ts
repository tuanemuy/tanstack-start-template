import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";

// The D1 adapter reuses the existing aggregate / outbox table definitions
// from the libSQL adapter — they are driver-agnostic `sqliteTable` schemas.
// The only D1-specific addition is the `_occ_guard` table below, which
// backs the deferred-batch UoW's optimistic-concurrency abort mechanism.
export { outboxEvents, todos } from "@/core/adapters/drizzleSqlite/schema";

// `_occ_guard` is the abort lever for OCC failures inside a `db.batch()`.
//
// D1 batches are atomic but treat `UPDATE ... WHERE version = ?` matching
// zero rows as a normal success — the batch commits the rest. To turn an
// OCC mismatch into a batch-wide rollback, each OCC-guarded write is
// followed by:
//
//     INSERT INTO _occ_guard (n) VALUES (changes());
//     DELETE FROM _occ_guard;
//
// `changes()` returns the row count touched by the immediately preceding
// statement. When that is 0, the CHECK constraint (`n > 0`) fails, the
// batch aborts, and the OCC handler in `PendingBatch` translates the
// driver error into a `ConflictError("OPTIMISTIC_LOCK_FAILURE")`.
export const occGuard = sqliteTable(
  "_occ_guard",
  {
    n: integer("n").notNull(),
  },
  (table) => [check("occ_guard_positive", sql`${table.n} > 0`)],
);
