import { AwsClient } from "aws4fetch";
import {
    deleteStorageObject,
    getStorageObject,
    isEnvStorageConfigured,
    putStorageObjectAtKey,
    resolveStorageTarget,
} from "./storage";
import { path_join } from "./path";

export type StorageType = "r2" | "s3" | "webdav";

export type StorageBody = Blob | ArrayBuffer | Uint8Array | string;

export class StorageError extends Error {
    constructor(message: string, public status = 0, public body = "") {
        super(message);
        this.name = "StorageError";
    }
}

export interface PresignedUpload {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
}

export interface StorageDriver {
    readonly kind: "env" | "s3" | "webdav";
    /** objectKey: 桶内完整路径（已包含 folder） */
    put(objectKey: string, body: StorageBody, contentType?: string): Promise<void>;
    get(objectKey: string, range?: string | null): Promise<Response | null>;
    head(objectKey: string): Promise<{ size: number } | null>;
    delete(objectKey: string): Promise<void>;
    presignPut?(objectKey: string, expiresInSeconds: number): Promise<PresignedUpload>;
}

export interface StorageConnection {
    type: StorageType;
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secret: string;
    forcePathStyle: boolean;
}

function trimSlash(value: string) {
    return value.replace(/\/+$/, "");
}

function encodeKey(key: string) {
    return key
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

/** 把存储端响应整理成对浏览器友好的响应（支持 Range、长缓存、防 MIME 嗅探）。 */
export function buildFileResponse(
    upstream: Response,
    options: { mime?: string; name?: string; immutable?: boolean } = {},
): Response {
    const headers = new Headers();
    const copy = ["content-type", "content-length", "content-range", "etag", "last-modified"];
    for (const name of copy) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }

    const upstreamType = headers.get("content-type") || "";
    if ((!upstreamType || upstreamType === "application/octet-stream" || upstreamType === "binary/octet-stream") && options.mime) {
        headers.set("Content-Type", options.mime);
    } else if (!upstreamType) {
        headers.set("Content-Type", "application/octet-stream");
    }

    const finalType = (headers.get("content-type") || "").toLowerCase();
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set(
        "Cache-Control",
        options.immutable === false ? "public, max-age=300" : "public, max-age=31536000, immutable",
    );

    // 可执行内容（HTML/SVG/JS 等）强制下载，避免上传文件在站点域名下执行脚本（存储型 XSS）。
    const dangerous = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)/.test(finalType);
    const inlineType = /^(image|video|audio)\//.test(finalType) || finalType.startsWith("application/pdf");
    const isSafeInline = inlineType && !dangerous;
    if (options.name) {
        const encoded = encodeURIComponent(options.name);
        headers.set(
            "Content-Disposition",
            `${isSafeInline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
        );
    } else if (!isSafeInline) {
        headers.set("Content-Disposition", "attachment");
    }

    return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// S3 兼容（含其他账号的 Cloudflare R2）
// ---------------------------------------------------------------------------

export class S3Driver implements StorageDriver {
    readonly kind = "s3" as const;
    private client: AwsClient;

    constructor(private conn: StorageConnection) {
        this.client = new AwsClient({
            accessKeyId: conn.accessKey,
            secretAccessKey: conn.secret,
            service: "s3",
            region: conn.region || "auto",
            // aws4fetch 默认对 5xx 重试 10 次（指数退避，最长可达近一分钟），会拖垮 Worker 请求；
            // 这里只重试一次，失败后由调用方切换到下一个存储。
            retries: 1,
        });
    }

    private urlFor(objectKey: string) {
        const encoded = encodeKey(objectKey);
        const endpoint = trimSlash(this.conn.endpoint);
        if (this.conn.forcePathStyle) {
            return `${endpoint}/${encodeURIComponent(this.conn.bucket)}/${encoded}`;
        }
        const url = new URL(endpoint);
        return `${url.protocol}//${this.conn.bucket}.${url.host}${url.pathname === "/" ? "" : trimSlash(url.pathname)}/${encoded}`;
    }

    async put(objectKey: string, body: StorageBody, contentType?: string) {
        const headers: Record<string, string> = {};
        if (contentType) headers["Content-Type"] = contentType;
        const res = await this.client.fetch(this.urlFor(objectKey), {
            method: "PUT",
            body: body as BodyInit,
            headers,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new StorageError(`S3 上传失败: ${res.status} ${res.statusText} ${text.slice(0, 300)}`.trim(), res.status, text);
        }
    }

    async get(objectKey: string, range?: string | null) {
        const headers: Record<string, string> = {};
        if (range) headers["Range"] = range;
        const res = await this.client.fetch(this.urlFor(objectKey), { method: "GET", headers });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new StorageError(`S3 读取失败: ${res.status} ${res.statusText}`, res.status);
        }
        return res;
    }

    async head(objectKey: string) {
        const res = await this.client.fetch(this.urlFor(objectKey), { method: "HEAD" });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new StorageError(`S3 检查失败: ${res.status} ${res.statusText}`, res.status);
        }
        return { size: Number(res.headers.get("content-length") || 0) };
    }

    async delete(objectKey: string) {
        const res = await this.client.fetch(this.urlFor(objectKey), { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
            throw new StorageError(`S3 删除失败: ${res.status} ${res.statusText}`, res.status);
        }
    }

    /** 生成预签名上传地址，浏览器可直接 PUT 到存储桶，不受 Worker 请求体大小限制。 */
    async presignPut(objectKey: string, expiresInSeconds: number): Promise<PresignedUpload> {
        const url = new URL(this.urlFor(objectKey));
        url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
        const signed = await this.client.sign(new Request(url.toString(), { method: "PUT" }), {
            aws: { signQuery: true },
        });
        return { url: signed.url, method: "PUT", headers: {} };
    }
}

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

export class WebDavDriver implements StorageDriver {
    readonly kind = "webdav" as const;
    private authorization: string;

    constructor(private conn: StorageConnection) {
        const raw = `${conn.accessKey}:${conn.secret}`;
        const bytes = new TextEncoder().encode(raw);
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        this.authorization = conn.accessKey || conn.secret ? `Basic ${btoa(binary)}` : "";
    }

    private headers(extra: Record<string, string> = {}) {
        const headers: Record<string, string> = { ...extra };
        if (this.authorization) headers["Authorization"] = this.authorization;
        return headers;
    }

    private urlFor(objectKey: string) {
        return `${trimSlash(this.conn.endpoint)}/${encodeKey(objectKey)}`;
    }

    private async ensureCollections(objectKey: string) {
        const segments = objectKey.split("/").filter(Boolean);
        segments.pop(); // 去掉文件名
        let current = "";
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            const res = await fetch(`${trimSlash(this.conn.endpoint)}/${encodeKey(current)}/`, {
                method: "MKCOL",
                headers: this.headers(),
            });
            // 201 创建成功；405 已存在；其它 4xx（如 409/301）按"已存在或稍后上传时再报错"处理
            if (res.status >= 500) {
                throw new StorageError(`WebDAV 创建目录失败: ${res.status} ${res.statusText}`, res.status);
            }
            if (res.status === 401 || res.status === 403) {
                throw new StorageError(`WebDAV 认证失败: ${res.status}`, res.status);
            }
        }
    }

    async put(objectKey: string, body: StorageBody, contentType?: string) {
        await this.ensureCollections(objectKey);
        const res = await fetch(this.urlFor(objectKey), {
            method: "PUT",
            headers: this.headers(contentType ? { "Content-Type": contentType } : {}),
            body: body as BodyInit,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new StorageError(`WebDAV 上传失败: ${res.status} ${res.statusText}`, res.status, text);
        }
    }

    async get(objectKey: string, range?: string | null) {
        const res = await fetch(this.urlFor(objectKey), {
            method: "GET",
            headers: this.headers(range ? { Range: range } : {}),
        });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new StorageError(`WebDAV 读取失败: ${res.status} ${res.statusText}`, res.status);
        }
        return res;
    }

    async head(objectKey: string) {
        const res = await fetch(this.urlFor(objectKey), { method: "HEAD", headers: this.headers() });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new StorageError(`WebDAV 检查失败: ${res.status} ${res.statusText}`, res.status);
        }
        return { size: Number(res.headers.get("content-length") || 0) };
    }

    async delete(objectKey: string) {
        const res = await fetch(this.urlFor(objectKey), { method: "DELETE", headers: this.headers() });
        if (!res.ok && res.status !== 404) {
            throw new StorageError(`WebDAV 删除失败: ${res.status} ${res.statusText}`, res.status);
        }
    }
}

// ---------------------------------------------------------------------------
// 环境变量绑定的默认存储（R2 binding 或 S3_* 变量）
// ---------------------------------------------------------------------------

export class EnvDriver implements StorageDriver {
    readonly kind = "env" as const;

    constructor(private env: Env) {}

    async put(objectKey: string, body: StorageBody, contentType?: string) {
        // objectKey 已经是完整路径，直接写入
        await putStorageObjectAtKey(this.env, objectKey, body, contentType);
    }

    async get(objectKey: string, range?: string | null) {
        return getStorageObject(this.env, objectKey, range);
    }

    async head(objectKey: string) {
        const res = await getStorageObject(this.env, objectKey, "bytes=0-0");
        if (!res) return null;
        const total = res.headers.get("content-range")?.split("/")[1];
        void res.body?.cancel();
        return { size: Number(total || res.headers.get("content-length") || 0) };
    }

    async delete(objectKey: string) {
        await deleteStorageObject(this.env, objectKey);
    }
}

export function createDriver(conn: StorageConnection): StorageDriver {
    if (conn.type === "webdav") return new WebDavDriver(conn);
    return new S3Driver(conn);
}

export function createEnvDriverIfConfigured(env: Env): { driver: EnvDriver; folder: string } | null {
    if (!isEnvStorageConfigured(env)) return null;
    // 校验配置是否完整（缺字段会抛出明确错误，如 "S3_ENDPOINT is not defined"）
    const target = resolveStorageTarget(env);
    return { driver: new EnvDriver(env), folder: target.folder };
}

/** 连接测试：写入一个小文件 → 读取 → 删除。 */
export async function testDriver(driver: StorageDriver, folder: string): Promise<void> {
    const objectKey = path_join(folder, `.rin-connection-test-${crypto.randomUUID()}.txt`);
    const payload = `rin-storage-test-${Date.now()}`;
    await driver.put(objectKey, payload, "text/plain");
    try {
        const res = await driver.get(objectKey);
        if (!res) throw new StorageError("写入成功但无法读回，请检查存储桶读权限");
        const text = await res.text();
        if (text !== payload) throw new StorageError("读回内容与写入内容不一致");
    } finally {
        await driver.delete(objectKey).catch(() => {});
    }
}

/** 判断错误是否表示"容量已满 / 配额用尽"。 */
export function isCapacityError(error: unknown): boolean {
    if (!(error instanceof StorageError)) return false;
    if (error.status === 507) return true;
    const text = `${error.message} ${error.body}`.toLowerCase();
    return /quotaexceeded|quota exceeded|storagequota|insufficient ?storage|not enough (space|storage)|no space left|disk full|storage limit/.test(text);
}
