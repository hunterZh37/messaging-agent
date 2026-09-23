ALTER TABLE `drafts` ADD `account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `drafts` ADD `subject` text;--> statement-breakpoint
UPDATE `drafts` SET `account_id` = (SELECT `account_id` FROM `messages` WHERE `messages`.`id` = `drafts`.`reply_to_message_id`) WHERE `account_id` IS NULL;--> statement-breakpoint
CREATE TABLE `__keep_draft_revisions` AS SELECT * FROM `draft_revisions`;--> statement-breakpoint
CREATE TABLE `__keep_draft_attachments` AS SELECT * FROM `draft_attachments`;--> statement-breakpoint
DELETE FROM `draft_revisions`;--> statement-breakpoint
DELETE FROM `draft_attachments`;--> statement-breakpoint
CREATE TABLE `__new_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`reply_to_message_id` text,
	`account_id` text,
	`subject` text,
	`original_text` text NOT NULL,
	`final_text` text,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`status` text NOT NULL,
	`mode` text DEFAULT 'reply' NOT NULL,
	`model` text NOT NULL,
	`sent_provider_message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_drafts` (`id`, `thread_id`, `reply_to_message_id`, `account_id`, `subject`, `original_text`, `final_text`, `to_addresses`, `cc_addresses`, `status`, `mode`, `model`, `sent_provider_message_id`, `error`, `created_at`, `updated_at`)
SELECT `id`, `thread_id`, `reply_to_message_id`, `account_id`, `subject`, `original_text`, `final_text`, `to_addresses`, `cc_addresses`, `status`, `mode`, `model`, `sent_provider_message_id`, `error`, `created_at`, `updated_at` FROM `drafts`;--> statement-breakpoint
DROP TABLE `drafts`;--> statement-breakpoint
ALTER TABLE `__new_drafts` RENAME TO `drafts`;--> statement-breakpoint
INSERT INTO `draft_revisions` SELECT * FROM `__keep_draft_revisions`;--> statement-breakpoint
INSERT INTO `draft_attachments` SELECT * FROM `__keep_draft_attachments`;--> statement-breakpoint
DROP TABLE `__keep_draft_revisions`;--> statement-breakpoint
DROP TABLE `__keep_draft_attachments`;
