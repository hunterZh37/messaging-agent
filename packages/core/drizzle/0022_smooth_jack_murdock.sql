CREATE TABLE `chat_files` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`text_excerpt` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_files_chat_idx` ON `chat_files` (`chat_id`,`created_at`);