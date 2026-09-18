CREATE TABLE `psych_declared` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`set_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `psych_axes` ADD `verdict` text DEFAULT 'mixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `psych_evidence` ADD `side` text DEFAULT 'for' NOT NULL;