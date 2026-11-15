import { desc, eq, inArray, sql } from "drizzle-orm";
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
    visits,
} from "../db/schema";
import { createEnvDriverIfConfigured } from "../utils/storage-drivers";
import { driverForRow, DEFAULT_STORAGE_ID } from "../utils/storage-manager";
import { decryptSecret } from "../utils/storage-secrets";

// 备份/恢复的纯逻辑层：快照生成、云端写入、自动备份、密钥体检等。
// 这里不依赖 Hono，路由在 backup.ts，方便单测直接调用。

export const BACKUP_SCHEMA_VERSION = 1;
/**
 * 单次快照最多带多少条访问明细。
 * `visits` 是「每次浏览一行」，热门站点动辄上百万行；全量塞进 JSON 会让
 * 备份文件暴涨、把 Worker 内存打满。PV/UV 汇总（visit_stats）始终完整备份，
 * 这里只对明细做时间倒序截断，并在 metadata / 恢复提示里说明。
 */
export const MAX_SNAPSHOT_VISITS = 20000;
export const MAX_CLOUD_BACKUPS = 3;
export const BACKUP_DIR_NAME = "backups";
export const CLOUD_BACKUPS_CACHE_KEY = "cloud_backups_list";
export const GITHUB_BACKUP_CONFIG_KEY = "github_backup_config";

export interface StoredGitHubConfig {
    owner: string;
    repo: string;
    branch: string;
    tokenEnc: string;
    path: string;
}

/** 获取并解密 GitHub 备份配置（从持久化 serverConfig 中读取） */
export async function getGitHubBackupConfig(env: Env, serverConfig: any): Promise<{
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
export async function getActiveStorageDriver(env: Env, db: any) {
    // 换账号恢复时，旧备份里的存储密钥往往已经解不开（JWT_SECRET 变了），
    // 这里按「启用的正常存储 → 环境变量默认存储 → 其他可解密存储」依次尝试，
    // 任何一步失败都不会让恢复入口彻底堵死。
    const rows = await db.select().from(storages);
    const byPriority = (a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0);

    const usable = rows
        .filter((row: any) => row.enabled === 1 && row.status === "ok")
        .sort(byPriority);
    const rest = rows.filter((row: any) => !(row.enabled === 1 && row.status === "ok")).sort(byPriority);

    const asTarget = (row: any) => ({
        driver: driverForRow(env, row),
        folder: row.folder ? `${row.folder}/${BACKUP_DIR_NAME}` : BACKUP_DIR_NAME,
        name: row.name,
        bucket: row.bucket,
        id: row.id,
    });

    for (const row of [...usable, ...rest]) {
        try {
            const target = asTarget(row);
            const driver = await target.driver;
            return { ...target, driver };
        } catch (error: any) {
            console.warn(`[backup] 存储 #${row.id} 不可用，已跳过：${error?.message || error}`);
        }
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
export function cleanBackupObjectKey(rawKey: string, bucketName?: string, storageName?: string): string {
    let key = rawKey.trim().replace(/^\/+/, "");
    if (storageName && key.startsWith(`${storageName}/`)) {
        key = key.slice(storageName.length + 1).replace(/^\/+/, "");
    }
    if (bucketName && key.startsWith(`${bucketName}/`)) {
        key = key.slice(bucketName.length + 1).replace(/^\/+/, "");
    }
    return key;
}

// 构建完整数据快照
export async function createSnapshot(db: any) {
    const [totalVisitRows] = await db.select({ count: sql<number>`count(*)` }).from(visits);
    const totalVisits = Number(totalVisitRows?.count ?? 0);

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
        visitRows,
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
        db.select().from(visits).orderBy(desc(visits.createdAt)).limit(MAX_SNAPSHOT_VISITS),
    ]);

    const totalMediaBytes = storageFileRows.reduce((acc: number, f: any) => acc + (f.size || 0), 0);
    const skippedVisits = Math.max(0, totalVisits - visitRows.length);

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
                visits: visitRows.length,
                visitsTotal: totalVisits,
            },
            truncated: skippedVisits > 0
                ? { visits: skippedVisits, reason: `访问明细只备份最近 ${MAX_SNAPSHOT_VISITS} 条` }
                : undefined,
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
            visits: visitRows,
        },
    };
}

/**
 * 恢复会整表替换 users，如果旧站点的管理员是另外一个 GitHub 账号，
 * 恢复后当前操作者就会变成普通用户（甚至不存在），再也进不了后台。
 * 这里在恢复前记下操作者身份，恢复后保证它仍然是管理员。
 */
export async function loadOperator(db: any, uid?: number) {
    if (!uid) return null;
    const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    const row = rows[0];
    if (!row?.openid) return null;
    return { openid: row.openid as string, username: row.username as string, avatar: row.avatar ?? "" };
}

export async function ensureOperatorAdmin(db: any, operator: { openid: string; username: string; avatar?: string | null } | null) {
    if (!operator?.openid) return false;

    const rows = await db.select().from(users);
    const existing = rows.find((row: any) => row.openid === operator.openid);

    if (existing) {
        if (existing.permission !== 1) {
            await db.update(users).set({ permission: 1 }).where(eq(users.id, existing.id));
        }
        return false;
    }

    const now = new Date();
    await db.insert(users).values({
        username: operator.username || "admin",
        openid: operator.openid,
        avatar: operator.avatar ?? "",
        permission: 1,
        createdAt: now,
        updatedAt: now,
    });
    return true;
}

/** 把一份快照写进云端 backups/ 目录，并维护 index.json 与 3 份滚动保留。 */
export async function putCloudBackup(
    target: { driver: any; folder: string; name: string },
    snapshot: any,
    serverConfig: any,
) {
    const jsonStr = JSON.stringify(snapshot, null, 2);
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `rin-backup-${dateStr}.json`;
    const objectKey = `${target.folder}/${fileName}`.replace(/\/+/g, "/");
    const indexKey = `${target.folder}/index.json`.replace(/\/+/g, "/");

    await target.driver.put(objectKey, jsonStr, "application/json");

    let backupList: any[] = [];
    try {
        const indexRes = await target.driver.get(indexKey);
        if (indexRes && indexRes.ok) {
            const text = await indexRes.text();
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) backupList = parsed;
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

    backupList = backupList.filter((b) => b?.key !== objectKey);
    backupList.unshift(newEntry);

    let prunedCount = 0;
    if (backupList.length > MAX_CLOUD_BACKUPS) {
        const toPrune = backupList.slice(MAX_CLOUD_BACKUPS);
        backupList = backupList.slice(0, MAX_CLOUD_BACKUPS);
        for (const old of toPrune) {
            if (old?.key) {
                await target.driver.delete(old.key).catch(() => {});
                prunedCount++;
            }
        }
    }

    await target.driver.put(indexKey, JSON.stringify(backupList, null, 2), "application/json");
    await serverConfig.set(CLOUD_BACKUPS_CACHE_KEY, backupList, true).catch(() => {});

    return {
        filename: fileName,
        target: target.name,
        path: objectKey,
        exportedAt: snapshot.exportedAt,
        metadata: snapshot.metadata,
        totalBackups: backupList.length,
        prunedCount,
    };
}

export const AUTO_BACKUP_LAST_AT_KEY = "backup_auto_last_at";
/** 自动备份间隔：默认每天一次；可用 serverConfig 的 backup_auto_interval_hours 覆盖。 */
export const DEFAULT_AUTO_BACKUP_INTERVAL_HOURS = 24;

/**
 * 定时任务里的自动备份：站点跑起来就每天往存储桶写一份快照，
 * 这样即使账号突然挂掉，桶里也一定有一份较新的备份可用。
 */
export async function backupCrontab(env: Env, db: any, serverConfig: any): Promise<{ skipped: string } | { key: string }> {
    try {
        const rawInterval = await serverConfig.get("backup_auto_interval_hours");
        const intervalHours =
            rawInterval === undefined || rawInterval === null || rawInterval === ""
                ? DEFAULT_AUTO_BACKUP_INTERVAL_HOURS
                : Number(rawInterval);
        if (!Number.isFinite(intervalHours) || intervalHours <= 0) return { skipped: "disabled" };

        const lastAt = Number(await serverConfig.get(AUTO_BACKUP_LAST_AT_KEY)) || 0;
        const now = Date.now();
        if (lastAt > 0 && now - lastAt < intervalHours * 3600 * 1000) {
            return { skipped: "not-due" };
        }

        const target = await getActiveStorageDriver(env, db);
        if (!target) return { skipped: "no-storage" };

        const result = await putCloudBackup(target, await createSnapshot(db), serverConfig);
        await serverConfig.set(AUTO_BACKUP_LAST_AT_KEY, now, true);
        return { key: result.path };
    } catch (error: any) {
        console.error("[backup] auto backup failed:", error?.message || error);
        return { skipped: "error" };
    }
}

/** 结构校验：在清空任何数据之前先确认备份文件是可用的。 */
export function assertValidSnapshot(payload: any): void {
    if (!payload || typeof payload !== "object") {
        throw new Error("备份文件内容不是有效的 JSON 对象");
    }

    if (payload.app !== "rin") {
        throw new Error("无效的备份文件结构，请确保使用的是 Rin 导出的备份包");
    }

    if (!payload.data || typeof payload.data !== "object") {
        throw new Error("备份文件缺少 data 字段，无法恢复");
    }

    const version = Number(payload.version ?? 0);
    if (Number.isFinite(version) && version > BACKUP_SCHEMA_VERSION) {
        throw new Error(
            `备份文件版本（${version}）高于当前程序支持的版本（${BACKUP_SCHEMA_VERSION}），请先升级程序再恢复`,
        );
    }
}

/** 恢复完成后回读数据库，返回真实的数据量（而不是照抄备份文件里的元数据）。 */
export async function countRows(db: any) {
    const countOf = async (table: any) => {
        const [row] = await db.select({ count: sql<number>`count(*)` }).from(table);
        return Number(row?.count ?? 0);
    };

    const [feedsCount, commentsCount, momentsCount, friendsCount, storagesCount, mediaFilesCount, usersCount, visitsCount] =
        await Promise.all([
            countOf(feeds),
            countOf(comments),
            countOf(moments),
            countOf(friends),
            countOf(storages),
            countOf(storageFiles),
            countOf(users),
            countOf(visits),
        ]);

    return {
        feeds: feedsCount,
        comments: commentsCount,
        moments: momentsCount,
        friends: friendsCount,
        storages: storagesCount,
        mediaFiles: mediaFilesCount,
        users: usersCount,
        visits: visitsCount,
    };
}

/** 备份文件本身有截断时，恢复后要明确告诉站长少的是什么。 */
export function truncationWarnings(payload: any): string[] {
    const truncated = payload?.metadata?.truncated;
    if (!truncated || typeof truncated !== "object") return [];

    const warnings: string[] = [];
    const visits = Number(truncated.visits ?? 0);
    if (visits > 0) {
        warnings.push(
            `这次备份只带了最近的访问明细，有 ${visits} 条更早的明细没有进备份；` +
            `文章 PV/UV 汇总数据是完整的，不受影响。`,
        );
    }
    return warnings;
}

/**
 * 恢复后检查那些用主密钥加密过的数据是否还能解开。
 * 换 Cloudflare 账号通常意味着换了 JWT_SECRET，此时自定义存储的 SecretKey /
 * GitHub 备份 token 会解不开，需要用户重新填写。
 */
export async function collectSecretWarnings(env: Env, db: any, serverConfig: any): Promise<string[]> {
    const warnings: string[] = [];

    try {
        const storageRows = await db.select().from(storages);
        const broken = [];
        for (const row of storageRows) {
            if (!row.secretEnc) continue;
            try {
                await decryptSecret(env, row.secretEnc);
            } catch {
                broken.push(row.name || `#${row.id}`);
            }
        }
        if (broken.length > 0) {
            warnings.push(
                `以下自定义存储的密钥无法解密（主密钥已变更）：${broken.join("、")}。` +
                `请在「存储管理」里重新填写它们的 SecretKey，或把 STORAGE_SECRET 设置为与备份时相同的值。`,
            );
        }
    } catch (error) {
        console.error("[backup] inspect storage secrets failed", error);
    }

    try {
        const gh = await getGitHubBackupConfig(env, serverConfig);
        const raw = await serverConfig.get(GITHUB_BACKUP_CONFIG_KEY);
        if (raw && !gh.configured && gh.owner && gh.repo) {
            warnings.push("GitHub 备份 token 无法解密，请在设置页重新填写。");
        }
    } catch (error) {
        console.error("[backup] inspect github config failed", error);
    }

    return warnings;
}

/** 恢复前把当前数据写一份到存储桶，恢复失败时可以再恢复回来。 */
export async function writeSafetySnapshot(target: any, db: any): Promise<string | null> {
    try {
        const snapshot = await createSnapshot(db);
        const key = `${target.folder}/pre-restore.json`.replace(/\/+/g, "/");
        await target.driver.put(key, JSON.stringify(snapshot, null, 2), "application/json");
        return key;
    } catch (error: any) {
        console.error("[backup] write safety snapshot failed:", error?.message || error);
        return null;
    }
}
