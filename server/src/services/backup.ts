import { inArray } from "drizzle-orm";
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
import { encryptSecret, decryptSecret } from "../utils/storage-secrets";

const BACKUP_SCHEMA_VERSION = 1;
const MAX_CLOUD_BACKUPS = 3;
const BACKUP_DIR_NAME = "backups";
const CLOUD_BACKUPS_CACHE_KEY = "cloud_backups_list";
const GITHUB_BACKUP_CONFIG_KEY = "github_backup_config";

interface StoredGitHubConfig {
    owner: string;
    repo: string;
    branch: string;
    tokenEnc: string;
    path: string;
}

/** 获取并解密 GitHub 备份配置（从持久化 serverConfig 中读取） */
async function getGitHubBackupConfig(env: Env, serverConfig: any): Promise<{
    owner: string;
    repo: string;
    branch: string;
    token: string;
    path: string;
    configured: boolean;
}> {
    const rawVal = await serverConfig.get(GITHUB_BACKUP_CONFIG_KEY);
    if (!rawVal) {
        return { owner: "", repo: "", branch: "main", token: "", path: "backups", configured: false };
    }

    let raw: StoredGitHubConfig | null = null;
    if (typeof rawVal === "string") {
        try {
            raw = JSON.parse(rawVal);
        } catch {
            return { owner: "", repo: "", branch: "main", token: "", path: "backups", configured: false };
        }
    } else if (typeof rawVal === "object") {
        raw = rawVal as StoredGitHubConfig;
    }

    if (!raw || !raw.owner || !raw.repo || !raw.tokenEnc) {
        return {
            owner: raw?.owner || "",
            repo: raw?.repo || "",
            branch: raw?.branch || "main",
            token: "",
            path: raw?.path || "backups",
            configured: false,
        };
    }

    try {
        const token = await decryptSecret(env, raw.tokenEnc);
        return {
            owner: raw.owner.trim(),
            repo: raw.repo.trim(),
            branch: (raw.branch || "main").trim(),
            token,
            path: (raw.path || "backups").trim().replace(/^\/+|\/+$/g, ""),
            configured: Boolean(raw.owner && raw.repo && token),
        };
    } catch (err) {
        console.error("[backup] decrypt github token error:", err);
        return {
            owner: raw.owner,
            repo: raw.repo,
            branch: raw.branch || "main",
            token: "",
            path: raw.path || "backups",
            configured: false,
        };
    }
}

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

/** 智能净化用户输入的云端文件路径 */
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

    // 执行数据恢复核心逻辑（严格防 SQL 变量溢出）
    async function executeRestore(db: any, cacheManager: any, payload: any) {
        if (!payload || !payload.data || payload.app !== "rin") {
            throw new Error("无效的备份文件结构，请确保使用的是 Rin 导出的备份包");
        }

        const data = payload.data;

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

        // 1. 清理原有数据
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

        // 2. 依次按依赖关系恢复
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

        await cacheManager.clear();
    }

    // 0. GET /backup/preview —— 获取即将备份的数据量预览
    app.get("/preview", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");

        const [feedCount, commentCount, momentCount, friendCount, storageCount] = await Promise.all([
            db.select().from(feeds),
            db.select().from(comments),
            db.select().from(moments),
            db.select().from(friends),
            db.select().from(storages),
        ]);

        const target = await getActiveStorageDriver(env, db);
        const gh = await getGitHubBackupConfig(env, serverConfig);

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
            targetGitHub: {
                configured: gh.configured,
                repo: gh.configured ? `${gh.owner}/${gh.repo}` : "未配置",
                branch: gh.branch,
                path: gh.path,
            },
        });
    }));

    // 1. GET /backup/export —— 下载本地备份 JSON 文件
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

    // 2. POST /backup/export-to-storage —— 备份并存入云存储专属 backups/ 目录
    app.post("/export-to-storage", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");

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
            await serverConfig.set(CLOUD_BACKUPS_CACHE_KEY, backupList, true).catch(() => {});

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

    // 3. GET /backup/storage-list —— 获取存储桶中的备份列表
    app.get("/storage-list", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");

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
        }

        if (items.length === 0) {
            try {
                const cached = await serverConfig.get(CLOUD_BACKUPS_CACHE_KEY);
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

    // 4. POST /backup/inspect-storage-backup —— 检查并预览存储桶备份文件
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
                error: `请输入以 .json 结尾的完整文件名，例如：backups/rin-backup-2026-10-24T01-43-36.json`,
            }, 400);
        }

        try {
            const fileRes = await target.driver.get(key);
            if (!fileRes || !fileRes.ok) {
                return c.json({ ok: false, error: `在存储桶中未找到文件: ${key}` }, 404);
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

    // 5. POST /backup/restore-from-storage —— 从存储桶备份恢复
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

    // 6. POST /backup/import —— 从上传的本地文件恢复
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

    // =========================================================================
    // ★ 以下为 GitHub 专属备份与恢复 API
    // =========================================================================

    // 7. GET /backup/github-config —— 获取 GitHub 备份配置
    app.get("/github-config", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");
        const cfg = await getGitHubBackupConfig(env, serverConfig);

        return c.json({
            ok: true,
            configured: cfg.configured,
            owner: cfg.owner,
            repo: cfg.repo,
            branch: cfg.branch,
            path: cfg.path,
            hasToken: Boolean(cfg.token),
        });
    }));

    // 8. POST /backup/github-config —— 保存/更新 GitHub 备份配置（立即写入持久化数据库）
    app.post("/github-config", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");

        const body = (await c.req.json().catch(() => ({}))) as {
            owner?: string;
            repo?: string;
            branch?: string;
            path?: string;
            token?: string;
        };

        const existing = await getGitHubBackupConfig(env, serverConfig);

        const owner = (body.owner !== undefined ? body.owner : existing.owner).trim();
        const repo = (body.repo !== undefined ? body.repo : existing.repo).trim();
        const branch = (body.branch !== undefined ? body.branch : existing.branch || "main").trim() || "main";
        const path = (body.path !== undefined ? body.path : existing.path || "backups").trim().replace(/^\/+|\/+$/g, "");

        let tokenToEncrypt = body.token?.trim();
        let tokenEnc = "";

        if (tokenToEncrypt) {
            tokenEnc = await encryptSecret(env, tokenToEncrypt);
        } else if (existing.token) {
            tokenEnc = await encryptSecret(env, existing.token);
        }

        if (!owner || !repo || !tokenEnc) {
            return c.json({ ok: false, error: "请完整填写仓库拥有者 (Owner)、仓库名 (Repo) 以及 GitHub Personal Access Token" }, 400);
        }

        const toSave: StoredGitHubConfig = {
            owner,
            repo,
            branch,
            path: path || "backups",
            tokenEnc,
        };

        // 立即持久化写入数据库
        await serverConfig.set(GITHUB_BACKUP_CONFIG_KEY, JSON.stringify(toSave), true);

        return c.json({
            ok: true,
            message: "GitHub 备份配置保存成功",
            configured: true,
            owner,
            repo,
            branch,
            path: toSave.path,
            hasToken: true,
        });
    }));

    // 9. POST /backup/github-test —— 测试 GitHub 仓库连接（优先使用前端输入框传入的实时参数，免保存直接测试！）
    app.post("/github-test", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");
        const body = (await c.req.json().catch(() => ({}))) as {
            owner?: string;
            repo?: string;
            token?: string;
        };

        const stored = await getGitHubBackupConfig(env, serverConfig);
        const owner = (body.owner?.trim() || stored.owner).trim();
        const repo = (body.repo?.trim() || stored.repo).trim();
        const token = (body.token?.trim() || stored.token).trim();

        if (!owner || !repo || !token) {
            return c.json({ ok: false, error: "请先在上方输入完整的 GitHub 用户名 (Owner)、仓库名 (Repo) 以及访问令牌 (Token)" }, 400);
        }

        try {
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Rin-Blog-Backup/1.0",
                },
            });

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                let detail = text;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.message) detail = parsed.message;
                } catch {}

                if (res.status === 404) {
                    return c.json({
                        ok: false,
                        error: `验证失败 (404 Not Found): 找不到仓库「${owner}/${repo}」。请确认仓库已在 GitHub 创建好，且 Token 拥有访问该私有仓库的权限 (Classic Token 勾选 repo，Fine-grained Token 授权该仓库)。`,
                    }, 400);
                }
                if (res.status === 401) {
                    return c.json({
                        ok: false,
                        error: `验证失败 (401 Unauthorized): 访问令牌 (Token) 无效或已过期，请重新生成。`,
                    }, 400);
                }
                return c.json({ ok: false, error: `GitHub 校验失败 (${res.status}): ${detail}` }, 400);
            }

            const repoData: any = await res.json();
            return c.json({
                ok: true,
                isPrivate: repoData.private === true,
                defaultBranch: repoData.default_branch,
                message: repoData.private
                    ? `连接成功！已成功连接到私有仓库「${owner}/${repo}」，符合安全标准。现在可以放心点击右下角【保存配置】！`
                    : `连接成功！⚠️ 警告：检测到仓库「${owner}/${repo}」为公开仓库（Public）！备份包含全站私密数据，强烈建议在 GitHub 仓库设置中改为 Private（私有）后再使用！`,
            });
        } catch (e: any) {
            return c.json({ ok: false, error: `网络请求 GitHub 失败: ${e.message}` }, 500);
        }
    }));

    // 10. POST /backup/export-to-github —— 导出全量快照并自动 Commit 到 GitHub 仓库
    app.post("/export-to-github", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");

        const cfg = await getGitHubBackupConfig(env, serverConfig);
        if (!cfg.configured) {
            return c.json({ ok: false, error: "请先配置并保存 GitHub 备份仓库信息" }, 400);
        }

        const snapshot = await createSnapshot(db);
        const jsonStr = JSON.stringify(snapshot, null, 2);
        const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const fileName = `rin-backup-${dateStr}.json`;
        const filePath = cfg.path ? `${cfg.path}/${fileName}` : fileName;

        // Base64 编码文件内容（UTF-8 安全）
        const bytes = new TextEncoder().encode(jsonStr);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const contentBase64 = btoa(binary);

        const commitMessage = `chore: auto backup ${fileName} [feeds:${snapshot.metadata.counts.feeds}, moments:${snapshot.metadata.counts.moments}]`;

        try {
            const putRes = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${filePath}`, {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${cfg.token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Rin-Blog-Backup/1.0",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    message: commitMessage,
                    content: contentBase64,
                    branch: cfg.branch,
                }),
            });

            if (!putRes.ok) {
                const text = await putRes.text();
                return c.json({ ok: false, error: `GitHub 写入失败 (${putRes.status}): ${text}` }, 400);
            }

            const putData: any = await putRes.json();

            return c.json({
                ok: true,
                filename: fileName,
                path: filePath,
                target: `GitHub (${cfg.owner}/${cfg.repo})`,
                commitSha: putData.commit?.sha?.slice(0, 7),
                htmlUrl: putData.content?.html_url,
                exportedAt: snapshot.exportedAt,
                metadata: snapshot.metadata,
            });
        } catch (e: any) {
            return c.json({ ok: false, error: `提交到 GitHub 异常: ${e.message}` }, 500);
        }
    }));

    // 11. GET /backup/github-list —— 从 GitHub 仓库直接列出所有历史备份快照
    app.get("/github-list", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");
        const cfg = await getGitHubBackupConfig(env, serverConfig);

        if (!cfg.configured) {
            return c.json({ ok: false, error: "未配置 GitHub 备份仓库" }, 400);
        }

        try {
            const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}?ref=${cfg.branch}`;
            const res = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${cfg.token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Rin-Blog-Backup/1.0",
                },
            });

            if (res.status === 404) {
                return c.json({
                    ok: true,
                    target: `${cfg.owner}/${cfg.repo}`,
                    items: [],
                });
            }

            if (!res.ok) {
                const text = await res.text();
                return c.json({ ok: false, error: `读取 GitHub 失败 (${res.status}): ${text}` }, 400);
            }

            const files: any[] = await res.json();
            if (!Array.isArray(files)) {
                return c.json({ ok: true, target: `${cfg.owner}/${cfg.repo}`, items: [] });
            }

            const backupFiles = files
                .filter((f) => f.type === "file" && f.name.startsWith("rin-backup-") && f.name.endsWith(".json"))
                .map((f) => ({
                    filename: f.name,
                    path: f.path,
                    downloadUrl: f.download_url,
                    size: f.size,
                    sha: f.sha,
                    createdAt: extractDateFromBackupName(f.name),
                }))
                .sort((a, b) => b.filename.localeCompare(a.filename));

            return c.json({
                ok: true,
                target: `${cfg.owner}/${cfg.repo}`,
                branch: cfg.branch,
                items: backupFiles,
            });
        } catch (e: any) {
            return c.json({ ok: false, error: `获取 GitHub 列表失败: ${e.message}` }, 500);
        }
    }));

    // 12. POST /backup/inspect-github-backup —— 下载并核对预览指定 GitHub 备份
    app.post("/inspect-github-backup", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const serverConfig = c.get("serverConfig");
        const cfg = await getGitHubBackupConfig(env, serverConfig);

        if (!cfg.configured) {
            return c.json({ ok: false, error: "未配置 GitHub 备份仓库" }, 400);
        }

        const body = (await c.req.json().catch(() => ({}))) as { path?: string };
        const filePath = body.path?.trim();
        if (!filePath) {
            return c.json({ ok: false, error: "缺少文件路径" }, 400);
        }

        try {
            const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${filePath}?ref=${cfg.branch}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${cfg.token}`,
                    Accept: "application/vnd.github.raw+json",
                    "User-Agent": "Rin-Blog-Backup/1.0",
                },
            });

            if (!res.ok) {
                return c.json({ ok: false, error: `无法从 GitHub 仓库读取文件 (${res.status})` }, 404);
            }

            const payload: any = await res.json();
            if (!payload || payload.app !== "rin" || !payload.data) {
                return c.json({ ok: false, error: "该文件不是有效的 Rin 备份文件" }, 400);
            }

            return c.json({
                ok: true,
                path: filePath,
                filename: filePath.split("/").pop() || filePath,
                exportedAt: payload.exportedAt || "未知",
                metadata: payload.metadata || {},
            });
        } catch (e: any) {
            return c.json({ ok: false, error: `解析 GitHub 文件失败: ${e.message}` }, 500);
        }
    }));

    // 13. POST /backup/restore-from-github —— 从 GitHub 仓库恢复全量数据
    app.post("/restore-from-github", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const cacheManager = c.get("cache");
        const serverConfig = c.get("serverConfig");
        const cfg = await getGitHubBackupConfig(env, serverConfig);

        if (!cfg.configured) {
            return c.json({ ok: false, error: "未配置 GitHub 备份仓库" }, 400);
        }

        const body = (await c.req.json().catch(() => ({}))) as { path?: string };
        const filePath = body.path?.trim();
        if (!filePath) {
            return c.json({ ok: false, error: "缺少备份文件路径" }, 400);
        }

        try {
            const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${filePath}?ref=${cfg.branch}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${cfg.token}`,
                    Accept: "application/vnd.github.raw+json",
                    "User-Agent": "Rin-Blog-Backup/1.0",
                },
            });

            if (!res.ok) {
                return c.json({ ok: false, error: `无法下载指定的 GitHub 备份文件 (${res.status})` }, 404);
            }

            const payload: any = await res.json();
            await executeRestore(db, cacheManager, payload);

            return c.json({
                ok: true,
                message: "从 GitHub 备份恢复成功！",
                counts: payload.metadata?.counts || {},
            });
        } catch (e: any) {
            return c.json({ ok: false, error: `恢复失败: ${e.message}` }, 500);
        }
    }));

    return app;
}

function extractDateFromBackupName(name: string): string {
    const match = /rin-backup-([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2})/.exec(name);
    if (!match) return "未知时间";
    return match[1].replace(/T/, " ").replace(/-/g, (m, offset) => (offset > 10 ? ":" : "-"));
}
