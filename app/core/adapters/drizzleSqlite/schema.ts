import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * todos - Todo table
 *
 * Timestamps (`createdAt` / `updatedAt`) are populated by the domain layer -
 * the infrastructure layer does NOT supply a SQL default. Keeping timestamp
 * logic in the entity makes tests deterministic and keeps the infrastructure
 * layer free of implicit business behaviour.
 *
 * `version` implements optimistic concurrency control. New aggregates start at
 * version `0` (inserted fresh). Every successful save increments it; updates
 * are guarded by the previous version so concurrent writers are rejected via a
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
 * produced them, then a separate relay worker drains the table asynchronously
 * by claiming rows with `processed_at IS NULL`.
 *
 * Column notes:
 * - `event_type` is the single source of truth for the event type. The JSON
 *   `payload` stores only `{ payload, aggregateId? }` - NO `type` field
 *   (avoiding the previous duplication).
 * - `schema_version` lets us evolve event payload shapes over time; relay
 *   workers can branch on it during decode.
 * - `lease_token` / `leased_until` enable atomic claim semantics so multiple
 *   concurrent relay workers do not double-dispatch. Claims expire so that a
 *   crashed worker's entries become re-claimable after the lease window.
 *
 * Delivery guarantee: AT-LEAST-ONCE. Consumers must be idempotent (e.g. keyed
 * on `event.id`).
 */
export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    sequence: integer("sequence").notNull().default(0),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    leaseToken: text("lease_token"),
    leasedUntil: integer("leased_until", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_outbox_pending")
      .on(table.sequence)
      .where(sql`processed_at IS NULL`),
    uniqueIndex("idx_outbox_sequence").on(table.sequence),
  ],
);

/**
 * Single-row sequence allocator for outbox insertion order.
 *
 * Domain event timestamps are not a safe ordering key: several events can be
 * emitted in the same millisecond, and a single transaction may emit multiple
 * events whose relative order matters. The writer increments this row inside
 * the same transaction before inserting outbox rows, then stamps each row with
 * a contiguous sequence number.
 */
export const outboxSequence = sqliteTable("outbox_sequence", {
  id: integer("id").primaryKey(),
  nextValue: integer("next_value").notNull(),
});
