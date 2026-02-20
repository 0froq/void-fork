DROP INDEX `users_github_id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_id`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_login`;--> statement-breakpoint
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`mode` text DEFAULT 'worker' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "user_id", "slug", "mode", "created_at") SELECT "id", "user_id", "slug", "mode", "created_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA defer_foreign_keys=off;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_user_id_slug_unique` ON `projects` (`user_id`,`slug`);