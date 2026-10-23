-- 多存储支持：自定义 R2 / S3 / WebDAV 存储 + 文件所在存储的映射表
CREATE TABLE IF NOT EXISTS `storages` (
  `id` integer PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `endpoint` text NOT NULL,
  `bucket` text DEFAULT '' NOT NULL,
  `region` text DEFAULT 'auto' NOT NULL,
  `access_key` text DEFAULT '' NOT NULL,
  `secret_enc` text DEFAULT '' NOT NULL,
  `force_path_style` integer DEFAULT 1 NOT NULL,
  `folder` text DEFAULT '' NOT NULL,
  `public_url` text DEFAULT '' NOT NULL,
  `redirect` integer DEFAULT 0 NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `quota_bytes` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'ok' NOT NULL,
  `last_error` text DEFAULT '' NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `storages_enabled_priority_idx` ON `storages` (`enabled`, `priority`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `storage_files` (
  `key` text PRIMARY KEY NOT NULL,
  `storage_id` integer DEFAULT 0 NOT NULL,
  `object_key` text NOT NULL,
  `name` text DEFAULT '' NOT NULL,
  `mime` text DEFAULT '' NOT NULL,
  `size` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `storage_files_storage_idx` ON `storage_files` (`storage_id`);
--> statement-breakpoint
UPDATE `info` SET `value` = '13' WHERE `key` = 'migration_version';
