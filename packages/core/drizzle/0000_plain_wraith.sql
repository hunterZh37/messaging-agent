CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_unique` ON `accounts` (`email`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`draft_id` text,
	`message_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`reply_to_message_id` text NOT NULL,
	`original_text` text NOT NULL,
	`final_text` text,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`sent_provider_message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`rfc_message_id` text,
	`from_address` text NOT NULL,
	`from_name` text,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`snippet` text,
	`attachment_names` text NOT NULL,
	`is_from_operator` integer NOT NULL,
	`sent_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_sent_at_idx` ON `messages` (`sent_at`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`account_id` text PRIMARY KEY NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`expiry_date` integer,
	`scope` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sorts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`important` integer NOT NULL,
	`needs_reply` integer NOT NULL,
	`scheduling` integer NOT NULL,
	`reason` text NOT NULL,
	`model` text NOT NULL,
	`labeled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`subject` text NOT NULL,
	`last_message_at` integer NOT NULL,
	`last_from_operator` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `watermarks` (
	`account_id` text PRIMARY KEY NOT NULL,
	`history_id` text NOT NULL,
	`last_sync_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
