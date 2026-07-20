CREATE TABLE `_occ_guard` (
	`n` integer NOT NULL,
	CONSTRAINT "occ_guard_positive" CHECK("_occ_guard"."n" > 0)
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`next_attempt_at`,`created_at`,`id`) WHERE processed_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE TABLE `processed_events` (
	`id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_todos_created_id` ON `todos` ("created_at" desc,"id" desc);