CREATE TABLE `thread_opens` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`opened_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
