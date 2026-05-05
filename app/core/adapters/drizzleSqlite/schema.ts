import { desc, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Timestamps are ms-precision so they round-trip with `Date` and align with
// outbox `occurred_at` and the UUIDv7 monotonic ordering encoded in `id`.
// All timestamps come from the application `Clock` (no SQL defaults) so
// fakes can freeze time deterministically.
export const todos = sqliteTable(
  "todos",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Backs `findPage`'s `ORDER BY created_at DESC, id DESC` paging key.
    // Without this the planner falls back to a sort over the full table
    // once the row count grows past the cache.
    index("idx_todos_created_id").on(desc(table.createdAt), desc(table.id)),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    // Claim/lease pair so multiple relay workers cannot dispatch the same
    // row. `claimed_at` is stamped at claim time; a row is re-claimable
    // once `claimed_at <= now - leaseMs` (covers crashed workers without
    // an explicit unclaim step). `claimed_by` is a free-form worker id
    // (from `IdGenerator`) — used only for diagnostics.
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    claimedBy: text("claimed_by"),
  },
  (table) => [
    // Pending = not yet processed, not quarantined, due for next attempt.
    // The relay worker queries this slice each tick; quarantined rows
    // (`failed_at IS NOT NULL`) are deliberately excluded from the index
    // so a poison row no longer pollutes the hot path. The claim/lease
    // filter is checked on top of this slice at claim time.
    index("idx_outbox_pending")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`processed_at IS NULL AND failed_at IS NULL`),
  ],
);
