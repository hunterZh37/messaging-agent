CREATE TABLE `eval_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`output` text,
	`latency_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `eval_results_run_idx` ON `eval_results` (`run_id`,`model`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`models` text NOT NULL,
	`sample_size` integer NOT NULL,
	`account_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
