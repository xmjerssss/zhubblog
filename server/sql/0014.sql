-- 用户表约束补强：
-- 1. openid 是登录身份的唯一标识（GitHub 用户 ID / 本地 admin），改成唯一索引，
--    避免并发首登写入重复用户。
-- 2. username 是账号密码登录的查询条件，补普通索引。
--
-- 如果历史数据里已经存在重复 openid，唯一索引会创建失败：
-- 可先执行 SELECT openid, COUNT(*) FROM users GROUP BY openid HAVING COUNT(*) > 1;
-- 人工合并重复行后重新运行迁移。

DROP INDEX IF EXISTS `users_openid_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_openid_unique_idx` ON `users` (`openid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_username_idx` ON `users` (`username`);
--> statement-breakpoint
UPDATE `info` SET `value` = '14' WHERE `key` = 'migration_version';
