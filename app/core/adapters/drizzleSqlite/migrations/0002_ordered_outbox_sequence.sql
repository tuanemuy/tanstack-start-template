ALTER TABLE `outbox_events` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `outbox_events` SET `sequence` = rowid;--> statement-breakpoint
DROP INDEX `idx_outbox_pending`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outbox_sequence` ON `outbox_events` (`sequence`);--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`sequence`) WHERE processed_at IS NULL;--> statement-breakpoint
CREATE TABLE `outbox_sequence` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_value` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `outbox_sequence` (`id`, `next_value`) SELECT 1, COALESCE(MAX(`sequence`), 0) + 1 FROM `outbox_events`;
