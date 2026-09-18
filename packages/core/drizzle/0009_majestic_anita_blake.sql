ALTER TABLE `messages` ADD `folder` text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_folder_idx` ON `messages` (`folder`);