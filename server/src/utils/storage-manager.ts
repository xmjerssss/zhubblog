import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { storageFiles, storages } from "../db/schema";
import { path_join } from "./path";
import { decryptSecret, encryptSecret } from "./storage-secrets";
import {
    createDriver,
    createEnvDriverIfConfigured,
    isCapacityError,
    type PresignedUpload,
    type StorageBody,
    type StorageConnection,
    type StorageDriver,
    type StorageType,
} from "./storage-drivers";
import { getStoragePublicUrl, resolveStorageTarget } from "./storage";

export type StorageRow = typeof storages.$inferSelect;
export type StorageFileRow = typeof storageFiles.$inferSelect;

export const DEFAULT_STORAGE_ID = 0;

/**
 * 单个 key 最多探测多少个「存储 + 路径」组合。
 * 不存在的 key（被删的老图 / 爬虫瞎扫）会逐个回源，必须给个上限，
 * 否则一次 404 可能打出十几次存储读请求。
 */
const MAX_FILE_SOURCE_CANDIDATES = 8;

/** 存储写满 / 配额用尽（R2、S3、WebDAV 的错误文案各不相同，统一按文案兜底识别）。 */
function looksLikeCapacityError(error: unknown): boolean {
    if (isCapacityError(error)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /quota|storage limit|no space|insufficient storage|bucket (is )?full|space left/i.test(message);
}

export type FileCategory = "images" | "videos" | "files";

/** 根据 MIME 类型和文件名后缀自动识别分类文件夹 */
export function detectFileCategory(mime?: string, fileName?: string): FileCategory {
    const lowerMime = (mime || "").toLowerCase();
    const lowerName = (fileName || "").toLowerCase();

    if (lowerMime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|avif)$/i.test(lowerName)) {
        return "images";
    }
    if (lowerMime.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v|ogv|flv|avi|wmv)$/i.test(lowerName)) {
        return "videos";
    }
    return "files";
}

function trimSlash(value: string) {
    return value.replace(/\/+$/, "");
}

export function sanitizeExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    if (idx < 0) return "";
    const ext = name.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
    return ext;
}

/** 构建带分类子目录的文件 key，例如 images/xxx.png, videos/xxx.mp4, files/xxx.zip */
export function buildFileKey(hashOrId: string, fileName: string, category?: FileCategory): string {
    const ext = sanitizeExtension(fileName);
    const fileWithExt = ext ? `${hashOrId}.${ext}` : hashOrId;
    const cat = category || detectFileCategory(undefined, fileName);
    return `${cat}/${fileWithExt}`;
}

export function buildBlobPath(key: string): string {
    return `/api/blob/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildBlobUrl(key: string, baseUrl?: string): string {
    const path = buildBlobPath(key);
    return baseUrl ? `${trimSlash(baseUrl)}${path}` : path;
}

export async function rowToConnection(env: Env, row: StorageRow): Promise<StorageConnection> {
    return {
        type: row.type as StorageType,
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region || "auto",
        accessKey: row.accessKey,
        secret: await decryptSecret(env, row.secretEnc),
        forcePathStyle: row.forcePathStyle === 1,
    };
}

export async function driverForRow(env: Env, row: StorageRow): Promise<StorageDriver> {
    return createDriver(await rowToConnection(env, row));
}

export async function listStorageUsage(db: DB): Promise<Map<number, { size: number; count: number }>> {
    const rows = await db
        .select({
            storageId: storageFiles.storageId,
            size: sql<number>`coalesce(sum(${storageFiles.size}), 0)`,
            count: sql<number>`count(*)`,
        })
        .from(storageFiles)
        .groupBy(storageFiles.storageId);
    return new Map(rows.map((row) => [row.storageId, { size: Number(row.size), count: Number(row.count) }]));
}

export async function listStorageRows(db: DB): Promise<StorageRow[]> {
    return db.select().from(storages).orderBy(desc(storages.priority), asc(storages.id));
}

export async function getStorageRow(db: DB, id: number): Promise<StorageRow | undefined> {
    const rows = await db.select().from(storages).where(eq(storages.id, id)).limit(1);
    return rows[0];
}

export async function getFileRow(db: DB, key: string): Promise<StorageFileRow | undefined> {
    const rows = await db.select().from(storageFiles).where(eq(storageFiles.key, key)).limit(1);
    return rows[0];
}

export async function recordFile(db: DB, row: Omit<StorageFileRow, "createdAt">) {
    await db
        .insert(storageFiles)
        .values(row)
        .onConflictDoUpdate({
            target: storageFiles.key,
            set: {
                storageId: row.storageId,
                objectKey: row.objectKey,
                name: row.name,
                mime: row.mime,
                size: row.size,
            },
        });
}

async function markStorage(db: DB, id: number, status: "ok" | "full" | "error", lastError = "") {
    await db
        .update(storages)
        .set({ status, lastError: lastError.slice(0, 500), updatedAt: new Date() })
        .where(eq(storages.id, id));
}

export interface UploadCandidate {
    id: number;
    row?: StorageRow;
    folder: string;
}

export async function pickUploadCandidates(db: DB, env: Env, incomingSize: number): Promise<UploadCandidate[]> {
    const rows = await db
        .select()
        .from(storages)
        .where(and(eq(storages.enabled, 1)))
        .orderBy(desc(storages.priority), asc(storages.id));

    const candidates: UploadCandidate[] = [];
    if (rows.length > 0) {
        const usage = await listStorageUsage(db);
        for (const row of rows) {
            if (row.status === "full") continue;
            if (row.quotaBytes > 0) {
                const used = usage.get(row.id)?.size ?? 0;
                if (used + incomingSize > row.quotaBytes) continue;
            }
            candidates.push({ id: row.id, row, folder: row.folder });
        }
    }

    candidates.push({ id: DEFAULT_STORAGE_ID, folder: env.S3_FOLDER || "" });
    return candidates;
}

export interface StoredFile {
    key: string;
    url: string;
    storageId: number;
    reused: boolean;
}

export interface FileMeta {
    key: string;
    name: string;
    mime: string;
    size: number;
}

/**
 * 复用之前先确认对象真的还在。
 *
 * 内容哈希作 key 意味着「同一个 key 永远是同一份内容」，所以记录命中就直接复用本身没错，
 * 错在记录可能指向一个早就丢了对象的位置：换过存储、桶被清空、手工删过图、上传中途只写了库
 * 没写对象……这时复用会把一个 404 的旧地址还给前端，表现为「上传成功但一直是破图」；
 * 又因为 key 不变、前端草稿值也没变，连保存按钮都不出现，用户完全无从下手。
 *
 * 所以复用前用 head 探一次；探不到就当作不存在，老老实实重传一遍（key 不变，依然幂等）。
 */
async function storedObjectExists(db: DB, env: Env, row: StorageFileRow): Promise<boolean> {
    try {
        let driver: StorageDriver;
        let folder = "";
        if (row.storageId === DEFAULT_STORAGE_ID) {
            const envDriver = createEnvDriverIfConfigured(env);
            if (!envDriver) return false;
            driver = envDriver.driver;
            folder = envDriver.folder;
        } else {
            const storage = await getStorageRow(db, row.storageId);
            if (!storage) return false;
            driver = await driverForRow(env, storage);
            folder = storage.folder;
        }
        const objectKey = row.objectKey || (folder ? path_join(folder, row.key) : row.key);
        return Boolean(await driver.head(objectKey));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 少数 WebDAV 服务端不支持 HEAD（405 / 501）：这是「问不出来」而不是「不存在」，
        // 按存在处理，否则每次上传都会白白把同一份内容重写一遍。
        if (/405|501|method not allowed|not implemented/i.test(message)) return true;
        // 其余探测失败（密钥解不开、网络抖动、权限不足）既不能冒认对象存在，
        // 也不该让整个上传跟着失败：按「无法确认」处理，交给后面的真实上传去试。
        console.warn(`[Storage] 校验 ${row.key} 是否仍在存储中失败，将按缺失重新上传`, error);
        return false;
    }
}

export async function storeFile(
    db: DB,
    env: Env,
    meta: FileMeta,
    body: StorageBody,
    baseUrl?: string,
): Promise<StoredFile> {
    const existing = await getFileRow(db, meta.key);
    if (existing && (await storedObjectExists(db, env, existing))) {
        return { key: meta.key, url: buildBlobUrl(meta.key, baseUrl), storageId: existing.storageId, reused: true };
    }

    const candidates = await pickUploadCandidates(db, env, meta.size);
    let lastError: unknown = null;
    let defaultStorageFull = false;

    for (const candidate of candidates) {
        try {
            if (candidate.id === DEFAULT_STORAGE_ID) {
                const envDriver = createEnvDriverIfConfigured(env);
                if (!envDriver) {
                    if (lastError) throw lastError;
                    resolveStorageTarget(env);
                    throw new Error("No storage is configured");
                }
                const cleanFolder = envDriver.folder.replace(/images\/?$/, "");
                const objectKey = path_join(cleanFolder, meta.key);
                await envDriver.driver.put(objectKey, body, meta.mime || undefined);
                await recordFile(db, {
                    key: meta.key,
                    storageId: DEFAULT_STORAGE_ID,
                    objectKey,
                    name: meta.name,
                    mime: meta.mime,
                    size: meta.size,
                });
                return {
                    key: meta.key,
                    url: getStoragePublicUrl(env, objectKey, baseUrl),
                    storageId: DEFAULT_STORAGE_ID,
                    reused: false,
                };
            }

            const row = candidate.row!;
            const driver = await driverForRow(env, row);
            const objectKey = path_join(row.folder, meta.key);
            await driver.put(objectKey, body, meta.mime || undefined);
            await recordFile(db, {
                key: meta.key,
                storageId: row.id,
                objectKey,
                name: meta.name,
                mime: meta.mime,
                size: meta.size,
            });
            if (row.status !== "ok" || row.lastError) {
                await markStorage(db, row.id, "ok");
            }
            return { key: meta.key, url: buildBlobUrl(meta.key, baseUrl), storageId: row.id, reused: false };
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Storage] upload to #${candidate.id} failed: ${message}`);
            if (candidate.id === DEFAULT_STORAGE_ID && looksLikeCapacityError(error)) {
                defaultStorageFull = true;
            }
            if (candidate.row) {
                try {
                    await markStorage(db, candidate.id, isCapacityError(error) ? "full" : "error", message);
                } catch (markError) {
                    console.error("[Storage] failed to update storage status", markError);
                }
            }
        }
    }

    if (defaultStorageFull) {
        throw new Error("默认存储（部署时绑定的 R2 / S3）已满或不可写入：请在后台「存储管理」添加新的存储后再上传。已发布文章里的旧图片不受影响，仍会从原来的存储读取。");
    }
    throw lastError instanceof Error ? lastError : new Error("Upload failed");
}

export interface DirectUploadPlan {
    storageId: number;
    objectKey: string;
    upload: PresignedUpload;
}

export async function planDirectUpload(
    db: DB,
    env: Env,
    key: string,
    size: number,
    expiresInSeconds = 3600,
): Promise<DirectUploadPlan | null> {
    const candidates = await pickUploadCandidates(db, env, size);
    for (const candidate of candidates) {
        if (!candidate.row) continue;
        if (candidate.row.type === "webdav") continue;
        try {
            const driver = await driverForRow(env, candidate.row);
            if (!driver.presignPut) continue;
            const objectKey = path_join(candidate.row.folder, key);
            const upload = await driver.presignPut(objectKey, expiresInSeconds);
            return { storageId: candidate.row.id, objectKey, upload };
        } catch (error) {
            console.error(`[Storage] presign for #${candidate.id} failed`, error);
        }
    }
    return null;
}

/**
 * 一个「可能存着这个对象」的位置。
 *
 * driver 是惰性的：只有真的轮到这个候选去读取时才会去解密密钥、构造驱动，
 * 命中第一个候选后不会为其余存储付出任何代价。
 */
export interface FileSource {
    driver?: StorageDriver;
    resolveDriver?: () => Promise<StorageDriver>;
    objectKey: string;
    row?: StorageFileRow;
    storage?: StorageRow;
    /**
     * 命中该候选后需要把 storage_files 记录纠正为真实位置。
     * 覆盖三种情况：记录不存在（旧文件）、存储 ID 悬空（旧存储被删）、
     * 对象路径与记录不一致（folder 变更 / 手工迁移）。
     */
    heal?: { storageId: number; objectKey: string };
}

export async function getSourceDriver(source: FileSource): Promise<StorageDriver | null> {
    if (source.driver) return source.driver;
    if (!source.resolveDriver) return null;
    try {
        return await source.resolveDriver();
    } catch (error: any) {
        console.warn(`[Storage] 存储 #${source.storage?.id ?? DEFAULT_STORAGE_ID} 不可用：${error?.message || error}`);
        return null;
    }
}

function uniqueObjectKeys(keys: Array<string | undefined | null>): string[] {
    const result: string[] = [];
    for (const key of keys) {
        if (!key) continue;
        const normalized = key.replace(/^\/+/, "");
        if (normalized && !result.includes(normalized)) {
            result.push(normalized);
        }
    }
    return result;
}

/** 该 key 在一个存储里可能的对象路径：数据库记录的精确路径 → folder + key → 裸 key */
function objectKeyCandidates(key: string, folder: string, recorded?: string): string[] {
    return uniqueObjectKeys([recorded, folder ? path_join(folder, key) : key, key]);
}

/**
 * 按优先级列出所有可能存着该对象的候选位置（不做任何网络请求）：
 * 1. storage_files 记录的存储（精确路径优先）
 * 2. 环境变量默认存储（R2 binding / S3_*）
 * 3. 其余存储（含已停用 / 归档桶，按 priority 从高到低）
 *
 * 这样即使 R2 存满后换了新存储、或把旧存储停用了，历史文章里的图片依然能读出来。
 */
export async function resolveFileSources(db: DB, env: Env, key: string): Promise<FileSource[]> {
    let fileRow: StorageFileRow | undefined;
    let rows: StorageRow[] = [];
    try {
        fileRow = await getFileRow(db, key);
        rows = await listStorageRows(db);
    } catch (error) {
        // 数据库抖动时不能让整站图片挂掉，继续尝试用默认存储兜底。
        console.error("[Storage] 读取存储记录失败，退回默认存储", error);
    }

    const sources: FileSource[] = [];
    const seen = new Set<string>();
    const push = (source: FileSource, storageId: number) => {
        if (sources.length >= MAX_FILE_SOURCE_CANDIDATES) return;
        const marker = `${storageId}:${source.objectKey}`;
        if (seen.has(marker)) return;
        seen.add(marker);
        sources.push(source);
    };

    const recordedStorageId = fileRow && fileRow.storageId !== DEFAULT_STORAGE_ID ? fileRow.storageId : null;

    if (fileRow && recordedStorageId !== null) {
        const storage = rows.find((row) => row.id === recordedStorageId);
        if (storage) {
            for (const objectKey of objectKeyCandidates(key, storage.folder, fileRow.objectKey)) {
                push(
                    {
                        resolveDriver: () => driverForRow(env, storage),
                        objectKey,
                        row: fileRow,
                        storage,
                        heal: objectKey === fileRow.objectKey ? undefined : { storageId: storage.id, objectKey },
                    },
                    storage.id,
                );
            }
        } else {
            // 记录还在但存储行已被删除：后面的全量扫描会把它找回来并自愈记录。
            console.warn(`[Storage] 文件 ${key} 指向已不存在的存储 #${recordedStorageId}，尝试全量兜底`);
        }
    }

    const envDriver = createEnvDriverIfConfigured(env);
    if (envDriver) {
        // 默认存储上传时会去掉 folder 末尾的 images 再拼 key，这里保持一致。
        const cleanFolder = envDriver.folder.replace(/images\/?$/, "");
        const recorded = fileRow?.storageId === DEFAULT_STORAGE_ID ? fileRow.objectKey : undefined;
        const candidates = objectKeyCandidates(key, cleanFolder, recorded);
        for (const objectKey of candidates) {
            push(
                {
                    driver: envDriver.driver,
                    objectKey,
                    row: fileRow?.storageId === DEFAULT_STORAGE_ID ? fileRow : undefined,
                    heal: recorded === objectKey ? undefined : { storageId: DEFAULT_STORAGE_ID, objectKey },
                },
                DEFAULT_STORAGE_ID,
            );
        }
    }

    for (const storage of rows) {
        if (storage.id === recordedStorageId) continue;
        for (const objectKey of objectKeyCandidates(key, storage.folder, undefined)) {
            push(
                {
                    resolveDriver: () => driverForRow(env, storage),
                    objectKey,
                    row: fileRow?.storageId === storage.id ? fileRow : undefined,
                    storage,
                    heal: { storageId: storage.id, objectKey },
                },
                storage.id,
            );
        }
    }

    return sources;
}

/** 兼容旧调用：只取第一个（最优）候选。 */
export async function resolveFileSource(db: DB, env: Env, key: string): Promise<FileSource | null> {
    const sources = await resolveFileSources(db, env, key);
    return sources[0] ?? null;
}

/** 当实际命中的位置与 storage_files 记录不一致时，把记录纠正回来，下次直接命中。 */
export async function healFileRecord(
    db: DB,
    key: string,
    target: { storageId: number; objectKey: string },
    meta?: { name?: string | null; mime?: string | null; size?: number | null },
) {
    try {
        await recordFile(db, {
            key,
            storageId: target.storageId,
            objectKey: target.objectKey,
            name: meta?.name || key.split("/").pop() || key,
            mime: meta?.mime || "",
            size: Number(meta?.size) || 0,
        });
    } catch (error) {
        console.warn(`[Storage] 回写文件记录失败（${key}）`, error);
    }
}

export { encryptSecret };
