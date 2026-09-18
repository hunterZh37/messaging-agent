CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`kind` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`latency_ms` integer NOT NULL,
	`cost_usd` real,
	`account_id` text,
	`ref` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `model_calls_at_idx` ON `model_calls` (`at`);--> statement-breakpoint
CREATE INDEX `model_calls_role_idx` ON `model_calls` (`role`,`at`);