ALTER TABLE `accounts` ADD `status` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `last_error` text;