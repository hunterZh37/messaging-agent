CREATE TABLE `tone_months` (
	`month` text PRIMARY KEY NOT NULL,
	`tone` text NOT NULL,
	`energy` text NOT NULL,
	`warmth` text NOT NULL,
	`note` text NOT NULL,
	`sampled` integer NOT NULL,
	`model` text NOT NULL,
	`read_at` integer NOT NULL
);
