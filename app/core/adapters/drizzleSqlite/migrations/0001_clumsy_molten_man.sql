PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_todos`("id", "title", "completed", "version", "created_at", "updated_at") SELECT "id", "title", "completed", 0, "created_at", "updated_at" FROM `todos`;--> statement-breakpoint
DROP TABLE `todos`;--> statement-breakpoint
ALTER TABLE `__new_todos` RENAME TO `todos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `leased_until` integer;--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`occurred_at`) WHERE processed_at IS NULL;