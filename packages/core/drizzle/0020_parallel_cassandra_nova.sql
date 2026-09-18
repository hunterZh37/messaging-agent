ALTER TABLE `chats` ADD `kind` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `title` text DEFAULT 'General' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `closed_at` integer;--> statement-breakpoint
-- The one conversation that existed before this becomes General, so the
-- live database opens on it rather than on a row with no name and no time.
UPDATE `chats` SET `kind` = 'general', `thread_id` = NULL, `title` = 'General', `updated_at` = `created_at` WHERE `updated_at` = 0;
