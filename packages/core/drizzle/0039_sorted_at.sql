ALTER TABLE `sorts` ADD `sorted_at` integer;
--> statement-breakpoint
UPDATE `sorts` SET `sorted_at` = `created_at` WHERE `sorted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `sorts_sorted_at_idx` ON `sorts` (`sorted_at`);
