import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { storageFiles, storages } from "../db/schema";
import { isEnvStorageConfigured } from "../utils/storage";
import { createEnvDriverIfConfigured, createDriver, testDriver, type StorageType } from "../utils/storage-drivers";
import { encryptSecret, decryptSecret } from "../utils/storage-secrets";
import {
    getStorageRow,
    listStorageRows,
    listStorageUsage,
    DEFAULT_STORAGE_ID,
    type StorageRow,
} from "../utils/storage-manager";

const TYPES: StorageType[] = ["r2", "s3", "webdav"];

interface StorageInput {
    name?: string;
    type?: string;
    endpoint?: string;
    bucket?: string;
    region?: string;
    accessKey?: string;
    secret?: string;
    forcePathStyle?: boolean;
    folder?: string;
    publicUrl?: string;
    redirect?: boolean;
    priority?: number;
    enabled?: boolean;
    quotaBytes?: number;
    status?: string;
}

function toPublic(row: StorageRow, usage?: { size: number; count: number }) {
    return {
        id: row.id,
        name: row.name,
        type: row.type as StorageType,
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region,
        accessKey: row.accessKey,
        hasSecret: Boolean(row.secretEnc),
        forcePathStyle: row.forcePathStyle === 1,
        folder: row.folder,
        publicUrl: row.publicUrl,
        redirect: row.redirect === 1,
        priority: row.priority,
        enabled: row.enabled === 1,
        quotaBytes: row.quotaBytes,
        usedBytes: usage?.size ?? 0,
        fileCount: usage?.count ?? 0,
        status: row.status as "ok" | "full" | "error",
        lastError: row.lastError,
    };
}

function normalizeFolder(value: string | undefined) {
    const parts = (value ?? "").split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.some((part) => part === ".." || part === ".")) {
        throw new Error("目录不能包含 . 或 ..");
    }
    return parts.join("/");
}

function normalizeHttpUrl(value: string | undefined, label: string, required: boolean) {
    const raw = (value ?? "").trim();
    if (!raw) {
        if (required) throw new Error(`${label}不能为空`);
        return "";
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${label}不是合法的 URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`${label}必须以 http:// 或 https:// 开头`);
    }
    return raw.replace(/\/+$/, "");
}

/** 校验并规范化表单；secret 为空表示保持原值（更新时）。 */
function validate(input: StorageInput, existing?: StorageRow) {
    const type = (input.type ?? existing?.type) as StorageType;
    if (!TYPES.includes(type)) throw new Error("不支持的存储类型");

    const name = (input.name ?? existing?.name ?? "").trim();
    if (!name) throw new Error("名称不能为空");
    if (name.length > 50) throw new Error("名称过长");

    const endpoint = normalizeHttpUrl(input.endpoint ?? existing?.endpoint, type === "webdav" ? "WebDAV 地址" : "Endpoint", true);
    const bucket = (input.bucket ?? existing?.bucket ?? "").trim();
    const accessKey = (input.accessKey ?? existing?.accessKey ?? "").trim();

    if (type !== "webdav") {
        if (!bucket) throw new Error("Bucket 不能为空");
        if (!accessKey) throw new Error("Access Key 不能为空");
    }

    const quotaBytes = Math.max(0, Math.floor(Number(input.quotaBytes ?? existing?.quotaBytes ?? 0)) || 0);
    const priority = Math.floor(Number(input.priority ?? existing?.priority ?? 0)) || 0;

    return {
        name,
        type,
        endpoint,
        bucket: type === "webdav" ? "" : bucket,
        region: (input.region ?? existing?.region ?? "auto").trim() || "auto",
        accessKey,
        forcePathStyle: (input.forcePathStyle ?? (existing ? existing.forcePathStyle === 1 : true)) ? 1 : 0,
        folder: normalizeFolder(input.folder ?? existing?.folder),
        publicUrl: normalizeHttpUrl(input.publicUrl ?? existing?.publicUrl, "公开访问域名", false),
        redirect: (input.redirect ?? (existing ? existing.redirect === 1 : false)) ? 1 : 0,
        priority,
        enabled: (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
        quotaBytes,
    };
}

export function StorageAdminService(): Hono {
    const app = new Hono();

    // GET /storages
    app.get("/", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const [rows, usage] = await Promise.all([listStorageRows(db), listStorageUsage(db)]);
        const defaultUsage = usage.get(DEFAULT_STORAGE_ID);
        return c.json({
            items: rows.map((row) => toPublic(row, usage.get(row.id))),
            defaultStorage: {
                configured: isEnvStorageConfigured(env),
                type: env.R2_BUCKET ? "r2-binding" : isEnvStorageConfigured(env) ? "s3" : null,
                fileCount: defaultUsage?.count ?? 0,
                usedBytes: defaultUsage?.size ?? 0,
            },
        });
    }));

    // POST /storages/test-default —— 测试环境变量绑定的默认存储
    app.post("/test-default", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const envDriver = createEnvDriverIfConfigured(env);
        if (!envDriver) return c.json({ ok: false, error: "未配置默认存储（R2 绑定或 S3_* 环境变量）" });
        try {
            await testDriver(envDriver.driver, envDriver.folder);
            return c.json({ ok: true });
        } catch (error: any) {
            return c.json({ ok: false, error: error?.message || String(error) });
        }
    }));

    // POST /storages/test-config —— 保存前先测试连接；传 id 且不填 secret 时沿用已保存的密钥
    app.post("/test-config", adminOnly(async (c: AppContext) => {
        const env = c.get("env");
        const db = c.get("db");
        const body = (await c.req.json().catch(() => ({}))) as StorageInput & { id?: number };
        try {
            const existing = body.id ? await getStorageRow(db, Number(body.id)) : undefined;
            const data = validate(body, existing);
            const secret = body.secret || (existing ? await decryptSecret(env, existing.secretEnc) : "");
            if (data.type !== "webdav" && !secret) throw new Error("Secret Key 不能为空");
            const driver = createDriver({
                type: data.type,
                endpoint: data.endpoint,
                bucket: data.bucket,
                region: data.region,
                accessKey: data.accessKey,
                secret,
                forcePathStyle: data.forcePathStyle === 1,
            });
            await testDriver(driver, data.folder);
            return c.json({ ok: true });
        } catch (error: any) {
            return c.json({ ok: false, error: error?.message || String(error) });
        }
    }));

    // POST /storages
    app.post("/", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const body = (await c.req.json().catch(() => ({}))) as StorageInput;
        try {
            const data = validate(body);
            if (data.type !== "webdav" && !body.secret) throw new Error("Secret Key 不能为空");
            const secretEnc = await encryptSecret(env, body.secret ?? "");
            const inserted = await db.insert(storages).values({ ...data, secretEnc }).returning();
            return c.json(toPublic(inserted[0]));
        } catch (error: any) {
            return c.json({ error: error?.message || "Invalid input" }, 400);
        }
    }));

    // PUT /storages/:id —— secret 留空表示不修改；status 可手动重置为 ok
    app.put("/:id", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const id = Number(c.req.param("id"));
        const existing = Number.isFinite(id) ? await getStorageRow(db, id) : undefined;
        if (!existing) return c.json({ error: "存储不存在" }, 404);

        const body = (await c.req.json().catch(() => ({}))) as StorageInput;
        try {
            const data = validate(body, existing);
            const patch: Partial<typeof storages.$inferInsert> = { ...data, updatedAt: new Date() };
            if (body.secret) patch.secretEnc = await encryptSecret(env, body.secret);
            if (body.status === "ok") {
                patch.status = "ok";
                patch.lastError = "";
            }
            const updated = await db.update(storages).set(patch).where(eq(storages.id, id)).returning();
            const usage = (await listStorageUsage(db)).get(id);
            return c.json(toPublic(updated[0], usage));
        } catch (error: any) {
            return c.json({ error: error?.message || "Invalid input" }, 400);
        }
    }));

    // POST /storages/:id/test
    app.post("/:id/test", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const env = c.get("env");
        const id = Number(c.req.param("id"));
        const row = Number.isFinite(id) ? await getStorageRow(db, id) : undefined;
        if (!row) return c.json({ error: "存储不存在" }, 404);
        try {
            const driver = createDriver({
                type: row.type as StorageType,
                endpoint: row.endpoint,
                bucket: row.bucket,
                region: row.region,
                accessKey: row.accessKey,
                secret: await decryptSecret(env, row.secretEnc),
                forcePathStyle: row.forcePathStyle === 1,
            });
            await testDriver(driver, row.folder);
            await db.update(storages).set({ status: "ok", lastError: "", updatedAt: new Date() }).where(eq(storages.id, id));
            return c.json({ ok: true });
        } catch (error: any) {
            const message = error?.message || String(error);
            await db.update(storages).set({ status: "error", lastError: message.slice(0, 500), updatedAt: new Date() }).where(eq(storages.id, id));
            return c.json({ ok: false, error: message });
        }
    }));

    // DELETE /storages/:id —— 已有文件的存储默认禁止删除（否则文章里的图片会失效）；force=1 才会连同文件记录一起删除
    app.delete("/:id", adminOnly(async (c: AppContext) => {
        const db = c.get("db");
        const id = Number(c.req.param("id"));
        const row = Number.isFinite(id) ? await getStorageRow(db, id) : undefined;
        if (!row) return c.json({ error: "存储不存在" }, 404);

        const usage = (await listStorageUsage(db)).get(id);
        const force = c.req.query("force") === "1";
        if (usage && usage.count > 0 && !force) {
            return c.json({
                error: `该存储里还有 ${usage.count} 个文件正在被使用，删除后这些文件将无法访问。建议改为"停用"（停用后不再上传新文件，旧文件仍可访问）。`,
                fileCount: usage.count,
            }, 409);
        }

        await db.delete(storageFiles).where(eq(storageFiles.storageId, id));
        await db.delete(storages).where(eq(storages.id, id));
        return c.json({ ok: true });
    }));

    return app;
}
