CREATE TABLE `alex_items` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`when_iso` text NOT NULL,
	`end_iso` text,
	`status` text NOT NULL,
	`alex_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alex_items_thread_idx` ON `alex_items` (`thread_id`,`created_at`);