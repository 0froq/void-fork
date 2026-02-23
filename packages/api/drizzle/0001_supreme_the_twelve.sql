CREATE INDEX `idx_deployments_project_id` ON `deployments` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_domains_project_id` ON `domains` (`project_id`,`created_at`);