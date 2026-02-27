CREATE INDEX `idx_deployments_project_status` ON `deployments` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_projects_user_id` ON `projects` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);