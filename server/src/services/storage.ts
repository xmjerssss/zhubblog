import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { buildFileResponse } from "../utils/storage-drivers";
import {
    DEFAULT_STORAGE_ID,
    buildBlobUrl,
    buildFileKey,
    detectFileCategory,
    getSourceDriver,
    healFileRecord,
    planDirectUpload,
    recordFile,
    resolveFileSources,
    storeFile,
} from "../utils/storage-manager";
import { getStorageRow, driverForRow } from "../utils/storage-manager";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

const HASH_SIZE_LIMIT = 20 * 1024 * 1024;
export const PROXY_UPLOAD_LIMIT = 95 * 1024 * 1024;
export const DIRECT_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

function randomId() {
    return crypto.randomUUID().replace(/-/g, "");
}

function statusForError(error: any) {
    return error?.message?.includes('is not defined') ? 500 : 400;
}

export function StorageService(): Hono {
    const app = new Hono();

    // POST /storage  —— 经 Worker 中转上传（根据文件类型自动进入 images / videos / files 目录）
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');
        const db = c.get('db');

        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const file = body.file as File | string | undefined;
        if (!file || typeof file === "string") {
            return c.text('file is required', 400);
        }
        const fileName = (typeof body.key === "string" && body.key) || file.name || "file";
        const category = detectFileCategory(file.type, fileName);

        if (file.size > PROXY_UPLOAD_LIMIT) {
            return c.text(`文件超过 ${Math.floor(PROXY_UPLOAD_LIMIT / 1024 / 1024)}MB，无法经服务器中转上传。请在后台添加 S3 / R2 存储以启用大文件直传。`, 413);
        }

        let identity: string;
        if (file.size <= HASH_SIZE_LIMIT) {
            const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
            const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest({ name: 'SHA-1' }, fileBuffer));
            identity = buf2hex(hashArray);
        } else {
            identity = randomId();
        }

        const meta = {
            key: buildFileKey(identity, fileName, category),
            name: file.name || fileName,
            mime: file.type || "",
            size: file.size,
        };

        try {
            const result = await profileAsync(c, 'storage_put', () =>
                storeFile(db, env, meta, file, new URL(c.req.url).origin));
            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            return c.text(e.message, statusForError(e));
        }
    });

    // POST /storage/presign  —— 大文件直传预签名（自动分发到 videos/ 或 files/ 目录）
    app.post('/presign', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');
        const db = c.get('db');
        const jwt = c.get('jwt');
        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await c.req.json().catch(() => null) as { name?: string; size?: number; type?: string } | null;
        const name = body?.name?.trim();
        const size = Number(body?.size);
        if (!name || !Number.isFinite(size) || size <= 0) {
            return c.text('Invalid input', 400);
        }
        if (size > DIRECT_UPLOAD_LIMIT) {
            return c.text(`文件超过 ${Math.floor(DIRECT_UPLOAD_LIMIT / 1024 / 1024 / 1024)}GB 上限`, 413);
        }

        const mime = body?.type || "";
        const category = detectFileCategory(mime, name);
        const key = buildFileKey(randomId(), name, category);
        const plan = await planDirectUpload(db, env, key, size);
        if (!plan) {
            return c.json({ mode: "proxy" });
        }

        const token = await jwt.sign({
            kind: "storage-upload",
            uid,
            key,
            storageId: plan.storageId,
            objectKey: plan.objectKey,
            name,
            mime,
            size,
            exp: Math.floor(Date.now() / 1000) + 3600 + 300,
        });

        return c.json({
            mode: "direct",
            url: plan.upload.url,
            method: plan.upload.method,
            headers: { ...plan.upload.headers, ...(mime ? { "Content-Type": mime } : {}) },
            token,
        });
    });

    // POST /storage/complete  —— 直传完成后确认写入
    app.post('/complete', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');
        const db = c.get('db');
        const jwt = c.get('jwt');
        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await c.req.json().catch(() => null) as { token?: string } | null;
        const payload = body?.token ? await jwt.verify(body.token) : false;
        if (!payload || payload.kind !== "storage-upload" || payload.uid !== uid) {
            return c.text('Invalid or expired upload token', 400);
        }

        const storage = await getStorageRow(db, Number(payload.storageId));
        if (!storage) {
            return c.text('Storage no longer exists', 400);
        }

        try {
            const driver = await driverForRow(env, storage);
            const head = await driver.head(String(payload.objectKey));
            if (!head) {
                return c.text('Uploaded object not found in storage', 400);
            }
            if (head.size && head.size !== Number(payload.size)) {
                return c.text('Uploaded object size mismatch', 400);
            }
        } catch (e: any) {
            console.error(e.message);
            return c.text(e.message, 400);
        }

        await recordFile(db, {
            key: String(payload.key),
            storageId: storage.id,
            objectKey: String(payload.objectKey),
            name: String(payload.name || ""),
            mime: String(payload.mime || ""),
            size: Number(payload.size),
        });

        return c.json({ url: buildBlobUrl(String(payload.key), new URL(c.req.url).origin) });
    });

    return app;
}

// ---------------------------------------------------------------------------
// /api/blob 边缘缓存
//
// 文件 key 是内容哈希（同 key 内容永不改变），所以可以放心缓存一年。
// 缓存命中时整条请求不碰 D1、不回源存储，首屏图片从几十毫秒的 Worker 读取
// 变成同机房缓存命中，这是图片加载速度提升最大的一环。
// ---------------------------------------------------------------------------

type EdgeCache = {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
};

function getEdgeCache(): EdgeCache | null {
    const store = (globalThis as any).caches;
    if (!store || !store.default) return null;
    return store.default as EdgeCache;
}

/** 缓存 key 去掉 query/hash：?v=123 之类的参数不应该造成多份副本。 */
function buildBlobCacheKey(url: string): Request {
    const target = new URL(url);
    target.search = "";
    target.hash = "";
    return new Request(target.toString(), { method: "GET" });
}

function matchesIfNoneMatch(ifNoneMatch: string | null | undefined, etag: string | null): boolean {
    if (!ifNoneMatch || !etag) return false;
    return ifNoneMatch
        .split(",")
        .map((value) => value.trim())
        .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

function toNotModified(response: Response): Response {
    const headers = new Headers();
    for (const name of ["cache-control", "etag", "last-modified", "access-control-allow-origin", "cross-origin-resource-policy"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
    }
    return new Response(null, { status: 304, headers });
}

function storeInEdgeCache(c: AppContext, cache: EdgeCache, cacheKey: Request, response: Response) {
    const pristine = new Response(response.clone().body, {
        status: response.status,
        headers: new Headers(response.headers),
    });
    const task = cache.put(cacheKey, pristine).catch((error) => {
        console.warn("[Blob] 写入边缘缓存失败", error);
    });
    try {
        c.executionCtx.waitUntil(task);
    } catch {
        // 没有 execution context（本地测试 / 非 Workers 运行时）时直接忽略。
    }
}

/**
 * 对象不存在时的响应。
 *
 * 必须显式 no-store：图片是按 URL 加载的，浏览器与中间的代理会把 404 一起缓存住，
 * 等对象补回来（例如重新上传同一张图）时，用户刷新看到的还是那张破图，
 * 会误判成「修了也没用」。
 */
function blobNotFound(c: AppContext) {
    return c.text("Not found", 404, { "Cache-Control": "no-store" });
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const db = c.get("db");
        const rawKey = c.req.path.replace(/^\/blob\/?/, "");

        if (!rawKey) {
            return c.text("Blob key is required", 400);
        }

        let key: string;
        try {
            key = decodeURIComponent(rawKey);
        } catch {
            return c.text("Invalid blob key", 400);
        }

        // 视频拖动进度条走 Range，不能缓存分片响应（Cache API 不支持 206）。
        const range = c.req.header("Range");
        const cache = range ? null : getEdgeCache();
        const cacheKey = cache ? buildBlobCacheKey(c.req.url) : null;

        if (cache && cacheKey) {
            try {
                const cached = await cache.match(cacheKey);
                if (cached) {
                    if (matchesIfNoneMatch(c.req.header("If-None-Match"), cached.headers.get("ETag"))) {
                        return toNotModified(cached);
                    }
                    const headers = new Headers(cached.headers);
                    headers.set("X-Edge-Cache", "HIT");
                    return new Response(cached.body, { status: cached.status, headers });
                }
            } catch (error) {
                console.warn("[Blob] 读取边缘缓存失败", error);
            }
        }

        try {
            const sources = await profileAsync(c, "blob_resolve", () => resolveFileSources(db, env, key));
            if (sources.length === 0) {
                return blobNotFound(c);
            }

            let redirectResponse: Response | null = null;

            for (let index = 0; index < sources.length; index += 1) {
                const source = sources[index];
                const storage = source.storage;

                if (storage?.redirect === 1 && storage.publicUrl) {
                    const target = `${storage.publicUrl.replace(/\/+$/, "")}/${source.objectKey
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/")}`;
                    const redirect = new Response(null, {
                        status: 302,
                        headers: { Location: target, "Cache-Control": "public, max-age=300" },
                    });
                    // 首选位置就是配置了公开域名的存储：按原策略直接跳转，避免多一次回源。
                    if (index === 0) return redirect;
                    // 兜底位置是 redirect 存储：先继续尝试直读，全都读不到再用它。
                    redirectResponse = redirectResponse || redirect;
                    continue;
                }

                const driver = await getSourceDriver(source);
                if (!driver) continue;

                let upstream: Response | null = null;
                try {
                    upstream = await profileAsync(c, "blob_fetch", () => driver.get(source.objectKey, range));
                } catch (error) {
                    console.error(`[Blob] 从存储 #${storage?.id ?? DEFAULT_STORAGE_ID} 读取 ${source.objectKey} 失败`, error);
                    continue;
                }
                if (!upstream) continue;

                // 命中位置与数据库记录不一致时回写记录，下次直接命中，不用再逐个探测。
                if (source.heal) {
                    const healing = healFileRecord(db, key, source.heal, {
                        name: source.row?.name,
                        mime: source.row?.mime || upstream.headers.get("content-type"),
                        size: Number(upstream.headers.get("content-length")) || undefined,
                    });
                    try {
                        c.executionCtx.waitUntil(healing);
                    } catch {
                        await healing;
                    }
                }

                const response = buildFileResponse(upstream, {
                    mime: source.row?.mime,
                    name: source.row?.name,
                });

                if (matchesIfNoneMatch(c.req.header("If-None-Match"), response.headers.get("ETag"))) {
                    return toNotModified(response);
                }

                if (cache && cacheKey && response.status === 200) {
                    storeInEdgeCache(c, cache, cacheKey, response);
                    const headers = new Headers(response.headers);
                    headers.set("X-Edge-Cache", "MISS");
                    return new Response(response.body, { status: 200, headers });
                }

                return response;
            }

            if (redirectResponse) return redirectResponse;
            return blobNotFound(c);
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
