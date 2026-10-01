ALTER TABLE `messages` ADD `trashed_at` integer;
--> statement-breakpoint
UPDATE `messages` SET `trashed_at` = (
  SELECT MAX(`a`.`created_at`) FROM `actions` `a`
  WHERE `a`.`message_id` = `messages`.`id` AND `a`.`kind` IN ('trash', 'hide')
)
WHERE `folder` = 'trash' AND `trashed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `messages_trash_order_idx` ON `messages` (`folder`, COALESCE(`trashed_at`, `sent_at`));
