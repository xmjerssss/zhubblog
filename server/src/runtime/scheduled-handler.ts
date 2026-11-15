import { drizzle } from "drizzle-orm/d1";
import { CacheImpl } from "../utils/cache";
import { configureLogging } from "../utils/logger";

export async function handleScheduled(
  _controller: ScheduledController | null,
  env: Env,
  ctx: ExecutionContext,
) {
  configureLogging(env);

  const schema = await import("../db/schema");
  const db = drizzle(env.DB, { schema });

  const serverConfig = new CacheImpl(db, env, "server.config", "database");
  const clientConfig = new CacheImpl(db, env, "client.config");
  const cache = new CacheImpl(db, env, "cache", undefined, clientConfig);

  const { backupCrontab } = await import("../services/backup");
  const { friendCrontab } = await import("../services/friends");
  const { rssCrontab } = await import("../services/rss");
  const { sitemapCrontab } = await import("../services/sitemap");

  // 每天往存储桶写一份快照，保证账号出事后桶里一定有较新的备份
  await backupCrontab(env, db, serverConfig);
  await friendCrontab(env, ctx, db, cache, serverConfig, clientConfig);
  await rssCrontab(env, db);
  await sitemapCrontab(env, db);
}
