import { inArray, desc } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import {
    cache,
    comments,
    feedHashtags,
    feeds,
    friends,
    hashtags,
    moments,
    storageFiles,
    storages,
    users,
    visitStats,
} from "../db/schema";
import { createEnvDriverIfConfigured } from "../utils/storage-drivers";
import { driverForRow, DEFAULT_STORAGE_ID } from "../utils/storage-manager";

const BACKUP_SCHEMA_VERSION = 1;
const MAX_CLOUD_BACKUPS = 3; // 云端最多保留 3 份备份
const BACKUP_DIR_NAME = "backups"; // 专属备份归档目录
const CLOUD_BACKUPS_CACHE_KEY = "cloud_backups_list";

/** 获取当前系统可用的最佳存储驱动并规划备份目录 */
async function getActiveStorageDriver(env: Env, db: any) {
    const customStorages = await db.select().from(storages);
    const active = customStorages.find((s: any) => s.enabled === 1 && s.status === "ok");
    if (active) {
        const driver = await driverForRow(env, active);
        const folder = active.folder ? `${active.folder}/${BACKUP_DIR_NAME}` : BACKUP_DIR_NAME;
        return { driver, folder, name: active.name, bucket: active.bucket, id: active.id };
    }
    const envDriver = createEnvDriverIfConfigured(env);
    if (envDriver) {
        const cleanEnvFolder = envDriver.folder.replace(/images\/?$/, "");
        const folder = cleanEnvFolder ? `${cleanEnvFolder}/${BACKUP_DIR_NAME}` : BACKUP_DIR_NAME;
        return { driver: envDriver.driver, folder, name: "环境变量默认存储", bucket: env.S3_BUCKET || "default", id: DEFAULT_STORAGE_ID };
    }
    return null;
}

/** 智能净化用户输入的云端文件路径，去除冗余的桶名或存储名前缀 */
function cleanBackupObjectKey(rawKey: string, bucketName?: string, storageName?: string): string {
    let key = rawKey.trim().replace(/^\/+/, "");
    if (storageName && key.startsWith(`${storageName}/`)) {
        key = key.slice(storageName.length + 1).replace(/^\/+/, "");
    }
    if (bucketName && key.startsWith(`${bucketName}/`)) {
        key = key.slice(bucketName.length + 1).replace(/^\/+/, "");
    }
    return key;
}

export function BackupService(): Hono {
    const app = new Hono();

    // 构建完整数据快照
    async function createSnapshot(db: any) {
        const [
            userRows,
            feedRows,
            momentRows,
            friendRows,
            commentRows,
            hashtagRows,
            feedHashtagRows,
            configRows,
            storageRows,
            storageFileRows,
            visitStatRows,
        ] = await Promise.all([
            db.select().from(users),
            db.select().from(feeds),
            db.select().from(moments),
            db.select().from(friends),
            db.select().from(comments),
            db.select().from(hashtags),
            db.select().from(feedHashtags),
            db.select().from(cache).where(inArray(cache.type, ["client.config", "server.config"])),
            db.select().from(storages),
            db.select().from(storageFiles),
            db.select().from(visitStats),
        ]);

        const totalMediaBytes = storageFileRows.reduce((acc: number, f: any) => acc + (f.size || 0), 0);

        return {
            version: BACKUP_SCHEMA_VERSION,
            app: "rin",
            exportedAt: new Date().toISOString(),
            metadata: {
                counts: {
                    feeds: feedRows.length,
                    moments: momentRows.length,
                    comments: commentRows.length,
                    friends: friendRows.length,
                    hashtags: hashtagRows.length,
                    storages: storageRows.length,
                    mediaFiles: storageFileRows.length,
                },
                mediaSummary: {
                    totalFiles: storageFileRows.length,
                    totalBytes: totalMediaBytes,
                },
            },
            data: {
                users: userRows,
                feeds: feedRows,
                moments: momentRows,
                friends: friendRows,
                comments: commentRows,
                hashtags: hashtagRows,
                feedHashtags: feedHashtagRows,
                configs: configRows,
                storages: storageRows,
                storageFiles: storageFileRows,
                visitStats: visitStatRows,
            },
        };
    }

    // 执行数据恢复核心逻辑（彻底解决 SQLite / D1 too many SQL variables 报错）
    async function executeRestore(db: any, cacheManager: any, payload: any) {
        if (!payload || !payload.data || payload.app !== "rin") {
            throw new Error("无效的备份文件结构，请确保使用的是 Rin 导出的备份包");
        }

        const data = payload.data;

        // 核心加固：动态计算列数，单次 SQL 变量严格保持在 30 以内，绝不超标
        async function safeInsert<T extends Record<string, any>>(table: any, rows: T[]) {
            if (!rows || rows.length === 0) return;
            const colCount = Math.max(1, Object.keys(rows[0]).length);
            const chunkSize = Math.max(1, Math.floor(30 / colCount));
            for (let i = 0; i < rows.length; i += chunkSize) {
                const chunk = rows.slice(i, i + chunkSize);
                await db.insert(table).values(chunk as any);
            }
        }

        const parseDate = (d: any) => (d ? new Date(d) : new Date());

        // 1. 清理原有数据（按外键依赖逆序安全清理）
        await db.delete(feedHashtags);
        await db.delete(comments);
        await db.delete(visitStats);
        await db.delete(feeds);
        await db.delete(hashtags);
        await db.delete(moments);
        await db.delete(friends);
        await db.delete(storageFiles);
        await db.delete(storages);
        await db.delete(cache).where(inArray(cache.type, ["client.config", "server.config"]));
        await db.delete(users);

        // 2. 依次按依赖关系安全恢复
        if (data.users?.length) {
            await safeInsert(users, data.users.map((u: any) => ({
                ...u,
                createdAt: parseDate(u.createdAt),
                updatedAt: parseDate(u.updatedAt),
            })));
        }

        if (data.hashtags?.length) {
            await safeInsert(hashtags, data.hashtags.map((h: any) => ({
                ...h,
                createdAt: parseDate(h.createdAt),
                updatedAt: parseDate(h.updatedAt),
            })));
        }

        if (data.feeds?.length) {
            await safeInsert(feeds, data.feeds.map((f: any) => ({
                ...f,
                createdAt: parseDate(f.createdAt),
                updatedAt: parseDate(f.updatedAt),
            })));
        }

        if (data.feedHashtags?.length) {
            await safeInsert(feedHashtags, data.feedHashtags.map((fh: any) => ({
                ...fh,
                createdAt: parseDate(fh.createdAt),
                updatedAt: parseDate(fh.updatedAt),
            })));
        }

        if (data.comments?.length) {
            await safeInsert(comments, data.comments.map((cm: any) => ({
                ...cm,
                createdAt: parseDate(cm.createdAt),
                updatedAt: parseDate(cm.updatedAt),
            })));
        }

        if (data.moments?.length) {
            await safeInsert(moments, data.moments.map((m: any) => ({
                ...m,
                createdAt: parseDate(m.createdAt),
                updatedAt: parseDate(m.updatedAt),
            })));
        }

        if (data.friends?.length) {
            await safeInsert(friends, data.friends.map((fr: any) => ({
                ...fr,
                createdAt: parseDate(fr.createdAt),
                updatedAt: parseDate(fr.updatedAt),
            })));
        }

        if (data.storages?.length) {
            await safeInsert(storages, data.storages.map((s: any) => ({
                ...s,
                createdAt: parseDate(s.createdAt),
                updatedAt: parseDate(s.updatedAt),
            })));
        }

        if (data.storageFiles?.length) {
            await safeInsert(storageFiles, data.storageFiles.map((sf: any) => ({
                ...sf,
                createdAt: parseDate(sf.createdAt),
            })));
        }

        if (data.configs?.length) {
            await safeInsert(cache, data.configs.map((cf: any) => ({
                ...cf,
                createdAt: parseDate(cf.createdAt),
                updatedAt: parseDate(cf.updatedAt),
            })));
        }

        if (data.visitStats?.length) {
            await safeInsert(visitStats, data.visitStats.map((vs: any) => ({
                ...vs,
                updatedAt: parseDate(vs.updatedAt),
            })));
        }

        // 清理缓存
        await cacheManager.clear();
    }

    // 0. GET /backup/preview —— 获取即将备份的数据量预览与目标存储
    app.get("/preview", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");

        const [feedCount, commentCount, momentCount, friendCount, storageCount] = await Promise.all([
            db.select().from(feeds),
            db.select().from(comments),
            db.select().from(moments),
            db.select().from(friends),
            db.select().from(storages),
        ]);

        const target = await getActiveStorageDriver(env, db);

        return c.json({
            ok: true,
            preview: {
                feedsCount: feedCount.length,
                commentsCount: commentCount.length,
                momentsCount: momentCount.length,
                friendsCount: friendCount.length,
                storagesCount: storageCount.length,
            },
            targetStorage: {
                configured: Boolean(target),
                name: target?.name || "未配置",
                folder: target ? target.folder : "",
            },
        });
    }));

    // 1. GET /backup/export —— 下载完整备份 JSON 文件到本地
    app.get("/export", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const snapshot = await createSnapshot(db);
        const jsonStr = JSON.stringify(snapshot, null, 2);
        const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const fileName = `rin-backup-${dateStr}.json`;

        return new Response(jsonStr, {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Cache-Control": "no-store",
            },
        });
    }));

    // 2. POST /backup/export-to-storage —— 备份并存入云存储专属 backups/ 目录（最多保留 3 份）
    app.post("/export-to-storage", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const cacheManager = c.get("cache");

        const target = await getActiveStorageDriver(env, db);
        if (!target) {
            return c.json({ ok: false, error: "未找到任何可用的存储桶，请先在「存储管理」绑定一个存储。" }, 400);
        }

        const snapshot = await createSnapshot(db);
        const jsonStr = JSON.stringify(snapshot, null, 2);
        const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const fileName = `rin-backup-${dateStr}.json`;
        const objectKey = `${target.folder}/${fileName}`.replace(/\/+/g, "/");
        const indexKey = `${target.folder}/index.json`.replace(/\/+/g, "/");

        try {
            await target.driver.put(objectKey, jsonStr, "application/json");

            let backupList: any[] = [];
            try {
                const indexRes = await target.driver.get(indexKey);
                if (indexRes && indexRes.ok) {
                    const text = await indexRes.text();
                    backupList = JSON.parse(text);
                    if (!Array.isArray(backupList)) backupList = [];
                }
            } catch {
                backupList = [];
            }

            const newEntry = {
                key: objectKey,
                filename: fileName,
                createdAt: snapshot.exportedAt,
                metadata: snapshot.metadata,
            };

            backupList = backupList.filter((b) => b.key !== objectKey);
            backupList.unshift(newEntry);

            let prunedCount = 0;
            if (backupList.length > MAX_CLOUD_BACKUPS) {
                const toPrune = backupList.slice(MAX_CLOUD_BACKUPS);
                backupList = backupList.slice(0, MAX_CLOUD_BACKUPS);
                for (const old of toPrune) {
                    if (old.key) {
                        await target.driver.delete(old.key).catch(() => {});
                        prunedCount++;
                    }
                }
            }

            await target.driver.put(indexKey, JSON.stringify(backupList, null, 2), "application/json");

            // 双重本地索引备份：存入 cache 表，保证即便云端 index.json 偶发读取受阻也能秒级恢复
            await cacheManager.set(CLOUD_BACKUPS_CACHE_KEY, backupList).catch(() => {});

            return c.json({
                ok: true,
                filename: fileName,
                target: target.name,
                path: objectKey,
                exportedAt: snapshot.exportedAt,
                metadata: snapshot.metadata,
                totalBackups: backupList.length,
                prunedCount,
            });
        } catch (error: any) {
            return c.json({ ok: false, error: `写入存储桶失败: ${error.message || String(error)}` }, 500);
        }
    }));

    // 3. GET /backup/storage-list —— 获取云端专属 backups/ 目录里的备份列表
    app.get("/storage-list", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const cacheManager = c.get("cache");

        const target = await getActiveStorageDriver(env, db);
        if (!target) {
            return c.json({ ok: false, error: "未配置存储桶" }, 400);
        }

        const indexKey = `${target.folder}/index.json`.replace(/\/+/g, "/");
        let items: any[] = [];
        let readError: string | null = null;
        try {
            const indexRes = await target.driver.get(indexKey);
            if (indexRes && indexRes.ok) {
                const text = await indexRes.text();
                items = JSON.parse(text);
                if (!Array.isArray(items)) items = [];
            }
        } catch (err: any) {
            readError = err?.message || String(err);
            console.error("[backup] storage-list read error:", err);
        }

        // 双重保障回退：若云端 index.json 未拿到，自动从本地数据库缓存读取
        if (items.length === 0) {
            try {
                const cached = await cacheManager.get(CLOUD_BACKUPS_CACHE_KEY);
                if (Array.isArray(cached) && cached.length > 0) {
                    items = cached;
                }
            } catch {}
        }

        return c.json({
            ok: true,
            target: target.name,
            items,
            error: items.length === 0 ? readError : undefined,
        });
    }));

    // 4. POST /backup/inspect-storage-backup —— 检查并预览指定路径的备份文件
    app.post("/inspect-storage-backup", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const body = (await c.req.json().catch(() => ({}))) as { key?: string };
        const rawKey = body.key?.trim();
        if (!rawKey) {
            return c.json({ ok: false, error: "请输入备份文件完整路径" }, 400);
        }

        const target = await getActiveStorageDriver(env, db);
        if (!target) {
            return c.json({ ok: false, error: "未配置存储桶" }, 400);
        }

        const key = cleanBackupObjectKey(rawKey, target.bucket, target.name);

        if (!key.endsWith(".json")) {
            return c.json({
                ok: false,
                error: `请输入以 .json 结尾的完整文件名，例如：backups/rin-backup-2026-10-24T01-43-36.json（您当前输入的是: ${rawKey}）`,
            }, 400);
        }

        try {
            const fileRes = await target.driver.get(key);
            if (!fileRes || !fileRes.ok) {
                return c.json({ ok: false, error: `在存储桶中未找到文件: ${key}（请确认路径与文件名拼写正确）` }, 404);
            }
            const payload = JSON.parse(await fileRes.text());
            if (!payload || payload.app !== "rin" || !payload.data) {
                return c.json({ ok: false, error: "该文件不是有效的 Rin 备份快照" }, 400);
            }

            return c.json({
                ok: true,
                key,
                filename: key.split("/").pop() || key,
                exportedAt: payload.exportedAt || "未知",
                metadata: payload.metadata || {},
            });
        } catch (error: any) {
            return c.json({ ok: false, error: error.message || "读取备份文件失败" }, 500);
        }
    }));

    // 5. POST /backup/restore-from-storage —— 从云端选定的一份备份文件恢复
    app.post("/restore-from-storage", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const cacheManager = c.get("cache");

        const body = (await c.req.json().catch(() => ({}))) as { key?: string };
        const rawKey = body.key?.trim();
        if (!rawKey) {
            return c.json({ ok: false, error: "缺少备份文件路径" }, 400);
        }

        const target = await getActiveStorageDriver(env, db);
        if (!target) {
            return c.json({ ok: false, error: "存储驱动未就绪" }, 400);
        }

        const key = cleanBackupObjectKey(rawKey, target.bucket, target.name);

        try {
            const fileRes = await target.driver.get(key);
            if (!fileRes || !fileRes.ok) {
                return c.json({ ok: false, error: `无法从存储桶读取指定的备份文件: ${key}` }, 404);
            }

            const payload = JSON.parse(await fileRes.text());
            await executeRestore(db, cacheManager, payload);

            return c.json({
                ok: true,
                message: "从云端备份恢复成功！",
                counts: payload.metadata?.counts || {},
            });
        } catch (error: any) {
            return c.json({ ok: false, error: error.message || "恢复失败" }, 500);
        }
    }));

    // 6. POST /backup/import —— 从上传的本地文件恢复全量数据
    app.post("/import", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const cacheManager = c.get("cache");
        let payload: any;

        const contentType = c.req.header("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
            const form = await c.req.parseBody();
            const file = form.file as File | string | undefined;
            if (!file || typeof file === "string") {
                return c.json({ ok: false, error: "请上传备份文件（.json）" }, 400);
            }
            try {
                payload = JSON.parse(await file.text());
            } catch {
                return c.json({ ok: false, error: "备份文件损坏，无法解析为 JSON" }, 400);
            }
        } else {
            payload = await c.req.json().catch(() => null);
        }

        try {
            await executeRestore(db, cacheManager, payload);
            return c.json({
                ok: true,
                message: "数据恢复成功！",
                counts: payload.metadata?.counts || {},
            });
        } catch (error: any) {
            return c.json({ ok: false, error: error.message || "恢复失败" }, 500);
        }
    }));

    return app;
}
