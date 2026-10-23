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

export async function storeFile(
    db: DB,
    env: Env,
    meta: FileMeta,
    body: StorageBody,
    baseUrl?: string,
): Promise<StoredFile> {
    const existing = await getFileRow(db, meta.key);
    if (existing) {
        const stillValid =
            existing.storageId === DEFAULT_STORAGE_ID || Boolean(await getStorageRow(db, existing.storageId));
        if (stillValid) {
            return { key: meta.key, url: buildBlobUrl(meta.key, baseUrl), storageId: existing.storageId, reused: true };
        }
    }

    const candidates = await pickUploadCandidates(db, env, meta.size);
    let lastError: unknown = null;

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
            if (candidate.row) {
                try {
                    await markStorage(db, candidate.id, isCapacityError(error) ? "full" : "error", message);
                } catch (markError) {
                    console.error("[Storage] failed to update storage status", markError);
                }
            }
        }
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

export interface FileSource {
    driver: StorageDriver;
    objectKey: string;
    row?: StorageFileRow;
    storage?: StorageRow;
}

export async function resolveFileSource(db: DB, env: Env, key: string): Promise<FileSource | null> {
    const fileRow = await getFileRow(db, key);

    if (fileRow && fileRow.storageId !== DEFAULT_STORAGE_ID) {
        const storage = await getStorageRow(db, fileRow.storageId);
        if (!storage) return null;
        return { driver: await driverForRow(env, storage), objectKey: fileRow.objectKey, row: fileRow, storage };
    }

    const envDriver = createEnvDriverIfConfigured(env);
    if (!envDriver) return null;
    return { driver: envDriver.driver, objectKey: fileRow?.objectKey ?? key, row: fileRow };
}

export { encryptSecret };
