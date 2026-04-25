import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * todos - Todo aggregate.
 *
 * Timestamps (`createdAt` / `updatedAt`) are populated by the domain layer —
 * the infrastructure layer does NOT supply a SQL default. Keeping timestamp
 * logic in the entity makes tests deterministic and keeps the infrastructure
 * layer free of implicit business behaviour.
 *
 * `version` implements optimistic concurrency control. New aggregates start
 * at version 0; every successful save increments it and updates are guarded
 * by the previous version so concurrent writers are rejected via
 * `ConflictError` rather than silently clobbering each other.
 */
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * outbox_events - Transactional outbox for domain events.
 *
 * Events are inserted in the same transaction as the entity changes that
 * produced them, then the relay worker drains the table by polling
 * `processed_at IS NULL`.
 *
 * Delivery guarantee: AT-LEAST-ONCE. Consumers must be idempotent (typically
 * keyed on `id`).
 */
export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_outbox_pending")
      .on(table.createdAt, table.id)
      .where(sql`processed_at IS NULL`),
  ],
);
