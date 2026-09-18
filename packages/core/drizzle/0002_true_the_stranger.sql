CREATE TABLE `mail_credentials` (
	`account_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `imap_host` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `imap_port` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `smtp_host` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `smtp_port` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `kind` text;