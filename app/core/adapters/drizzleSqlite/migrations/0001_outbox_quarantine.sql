DROP INDEX `idx_outbox_pending`;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `failed_at` integer;--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`next_attempt_at`,`created_at`,`id`) WHERE processed_at IS NULL AND failed_at IS NULL;