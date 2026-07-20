-- D1 adapter initial schema. Mirrors the libSQL adapter's tables and
-- adds `_occ_guard` for the deferred-batch UoW's OCC abort mechanism.

CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE INDEX `idx_todos_created_id` ON `todos` ("created_at" desc,"id" desc);

CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`failed_at` integer,
	`claimed_at` integer,
	`claimed_by` text
);

CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`next_attempt_at`,`created_at`,`id`)
WHERE processed_at IS NULL AND failed_at IS NULL;

CREATE TABLE `processed_events` (
	`id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);

-- Aborts a `db.batch()` when the immediately-preceding OCC-guarded write
-- matched zero rows. See app/core/adapters/d1/schema.ts for the full rationale.
CREATE TABLE `_occ_guard` (
	`n` integer NOT NULL,
	CONSTRAINT `occ_guard_positive` CHECK(`n` > 0)
);
