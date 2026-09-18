CREATE TABLE `draft_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`instruction` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_revisions_draft_idx` ON `draft_revisions` (`draft_id`,`created_at`);