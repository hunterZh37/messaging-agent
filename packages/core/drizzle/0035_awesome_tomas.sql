CREATE TABLE `psych_axes` (
	`axis` text PRIMARY KEY NOT NULL,
	`letter` text NOT NULL,
	`agreement` integer NOT NULL,
	`runs` integer NOT NULL,
	`confidence` text NOT NULL,
	`reasoning` text NOT NULL,
	`model` text NOT NULL,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `psych_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`axis` text NOT NULL,
	`message_id` text NOT NULL,
	`quote` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `psych_evidence_axis_idx` ON `psych_evidence` (`axis`,`sent_at`);