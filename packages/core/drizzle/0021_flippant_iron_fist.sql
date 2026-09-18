CREATE TABLE `draft_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`text_excerpt` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_attachments_draft_idx` ON `draft_attachments` (`draft_id`,`created_at`);