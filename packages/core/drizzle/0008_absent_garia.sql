CREATE TABLE `embedding_state` (
	`message_id` text PRIMARY KEY NOT NULL,
	`embedded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_assignments` (
	`message_id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`source` text NOT NULL,
	`score` real,
	`assigned_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_assignments_project_idx` ON `project_assignments` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
