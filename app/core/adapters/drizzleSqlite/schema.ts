import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `status` mirrors the discriminator on the `Todo` aggregate so adding a
 * future variant is a domain change without a migration. `version`
 * implements optimistic concurrency control. Timestamps are millisecond-
 * precision so they round-trip with `Date` losslessly and stay aligned
 * with the outbox `occurred_at` / UUIDv7 ordering.
 */
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Transactional outbox for domain events. Delivery is at-least-once;
 * consumers must be idempotent (typically keyed on `id`). Rows with
 * `processed_at IS NOT NULL` are retained for audit and pruned by
 * `pruneOutbox`.
 *
 * `created_at` is millisecond-precision so it agrees with `occurred_at`
 * (domain timestamp) and the UUIDv7 monotonic ordering encoded into `id`.
 */
export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
  },
  (table) => [
    index("idx_outbox_pending")
      .on(table.createdAt, table.id)
      .where(sql`processed_at IS NULL`),
  ],
);
