import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Database } from "bun:sqlite";
import type { JWTUtils, Variables } from "../../core/hono-types";
import { cleanupTestDB, createMockDB, createMockEnv } from "../../../tests/fixtures";
import { BlobService, StorageService } from "../storage";
import { StorageAdminService } from "../storage-admin";
import { createJWT } from "../../utils/jwt";

/** 内存版"对象存储"：同时模拟 S3 (aws4fetch 签名请求) 与 WebDAV。 */
class FakeRemote {
    objects = new Map<string, { body: Uint8Array; type: string }>();
    failPut: ((url: string) => Response | null) | null = null;
    puts: string[] = [];

    install() {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: any, init?: any) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = request.url.split("?")[0];
            if (!/^https:\/\/(s3-|dav-)/.test(url) && !/^https:\/\/[a-z0-9-]+\.(s3|dav)\.test/.test(url)) {
                return original(input, init);
            }
            const method = request.method;
            if (method === "MKCOL") return new Response(null, { status: 201 });
            if (method === "PUT") {
                const fail = this.failPut?.(url);
                if (fail) return fail;
                this.puts.push(url);
                const body = new Uint8Array(await request.arrayBuffer());
                this.objects.set(url, { body, type: request.headers.get("content-type") || "" });
                return new Response(null, { status: 200 });
            }
            const object = this.objects.get(url);
            if (method === "DELETE") {
                this.objects.delete(url);
                return new Response(null, { status: 204 });
            }
            if (!object) return new Response("not found", { status: 404 });
            if (method === "HEAD") {
                return new Response(null, { status: 200, headers: { "content-length": String(object.body.length) } });
            }
            const range = request.headers.get("range");
            if (range) {
                const match = /bytes=(\d+)-(\d*)/.exec(range)!;
                const start = Number(match[1]);
                const end = match[2] ? Number(match[2]) : object.body.length - 1;
                return new Response((object.body.slice(start, end + 1) as any), {
                    status: 206,
                    headers: {
                        "content-type": object.type,
                        "content-range": `bytes ${start}-${end}/${object.body.length}`,
                    },
                });
            }
            return new Response((object.body as any), { status: 200, headers: { "content-type": object.type } });
        }) as typeof fetch;
        return () => {
            globalThis.fetch = original;
        };
    }
}

describe("多存储：自定义 R2 / S3 / WebDAV", () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let remote: FakeRemote;
    let restoreFetch: () => void;

    beforeEach(() => {
        const mock = createMockDB();
        db = mock.db;
        sqlite = mock.sqlite;
        remote = new FakeRemote();
        restoreFetch = remote.install();
        sqlite.exec(`INSERT INTO users (id, username, openid, permission) VALUES (1, 'admin', 'gh_admin', 1)`);
    });

    afterEach(() => {
        restoreFetch();
        cleanupTestDB(sqlite);
    });

    // 默认存储：一个用内存 Map 模拟的 R2 binding
    function makeEnv(defaultFiles = new Map<string, Uint8Array>()) {
        env = createMockEnv({
            R2_BUCKET: {
                put: async (key: string, value: any) => {
                    const buffer = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new TextEncoder().encode(String(value));
                    defaultFiles.set(key, buffer);
                    return { key } as unknown as R2Object;
                },
                get: async (key: string) => {
                    const data = defaultFiles.get(key);
                    if (!data) return null;
                    return {
                        key,
                        size: data.length,
                        httpEtag: "etag",
                        uploaded: new Date(),
                        writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/png"),
                        body: new Blob([data as any]).stream(),
                    } as unknown as R2ObjectBody;
                },
                delete: async (key: string) => {
                    defaultFiles.delete(key);
                },
            } as unknown as R2Bucket,
            S3_ACCESS_HOST: "" as any,
        });
        return defaultFiles;
    }

    function buildApp(options: { admin?: boolean; uid?: number | undefined } = {}) {
        const jwt = createJWT("test-secret");
        const app = new Hono<{ Bindings: Env; Variables: Variables }>();
        app.use(createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
            c.set("db", db);
            c.set("env", env);
            c.set("jwt", jwt as unknown as JWTUtils);
            c.set("admin", options.admin ?? true);
            c.set("uid", "uid" in options ? options.uid : 1);
            await next();
        }));
        app.route("/storage", StorageService());
        app.route("/storages", StorageAdminService());
        app.route("/blob", BlobService());
        return app;
    }

    async function addStorage(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
        const res = await app.request("/storages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }, env);
        expect(res.status).toBe(200);
        return (await res.json()) as any;
    }

    const s3Config = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        type: "s3",
        endpoint: `https://s3-${name}.test`,
        bucket: "bkt",
        accessKey: "AK",
        secret: "SK-secret-value",
        forcePathStyle: true,
        ...extra,
    });

    async function upload(app: ReturnType<typeof buildApp>, content: string, name = "a.png", type = "image/png") {
        const form = new FormData();
        form.append("key", name);
        form.append("file", new File([content], name, { type }));
        const res = await app.request("/storage", { method: "POST", body: form }, env);
        expect(res.status).toBe(200);
        return ((await res.json()) as { url: string }).url;
    }

    it("没有自定义存储时回退到环境变量存储", async () => {
        const files = makeEnv();
        const app = buildApp();
        const url = await upload(app, "hello");
        expect(url).toMatch(/\/api\/blob\/images\/[a-f0-9]+\.png$/);
        expect(files.size).toBe(1);
        const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello");
    });

    it("有自定义存储时优先上传到自定义存储，不再写入默认存储", async () => {
        const files = makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a"));
        const url = await upload(app, "custom-file");

        expect(files.size).toBe(0);
        expect(remote.objects.size).toBe(1);
        expect([...remote.objects.keys()][0]?.startsWith("https://s3-a.test/bkt/")).toBe(true);

        const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("custom-file");
    });

    it("更换存储后，旧存储里的文件依然可以访问（核心需求）", async () => {
        makeEnv();
        const app = buildApp();
        const a = await addStorage(app, s3Config("a", { priority: 10 }));
        const urlA = await upload(app, "file-in-a", "one.png");

        // A 满了：停用 A，换成 B
        await app.request(`/storages/${a.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: false }),
        }, env);
        await addStorage(app, s3Config("b", { priority: 5 }));
        const urlB = await upload(app, "file-in-b", "two.png");

        expect([...remote.objects.keys()].some((k) => k.startsWith("https://s3-a.test/"))).toBe(true);
        expect([...remote.objects.keys()].some((k) => k.startsWith("https://s3-b.test/"))).toBe(true);

        for (const [url, expected] of [[urlA, "file-in-a"], [urlB, "file-in-b"]] as const) {
            const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
            expect(res.status).toBe(200);
            expect(await res.text()).toBe(expected);
        }
    });

    it("旧版本上传的文件（默认存储，无数据库记录）在添加自定义存储后仍可访问", async () => {
        const files = makeEnv();
        files.set("images/legacy.png", new TextEncoder().encode("legacy"));
        const app = buildApp();
        await addStorage(app, s3Config("a"));
        const res = await app.request("/blob/images/legacy.png", {}, env);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("legacy");
    });

    it("存储容量错误时自动标记为已满并切换到下一个存储", async () => {
        makeEnv();
        const app = buildApp();
        const a = await addStorage(app, s3Config("a", { priority: 10 }));
        await addStorage(app, s3Config("b", { priority: 5 }));
        remote.failPut = (url) => url.startsWith("https://s3-a.test/") ? new Response("<Error><Code>QuotaExceeded</Code></Error>", { status: 507 }) : null;

        const url = await upload(app, "needs-b");
        expect([...remote.objects.keys()][0]?.startsWith("https://s3-b.test/")).toBe(true);

        const list = (await (await app.request("/storages", {}, env)).json()) as any;
        const storageA = list.items.find((i: any) => i.id === a.id);
        expect(storageA.status).toBe("full");

        // 之后的上传不会再尝试 A
        remote.puts.length = 0;
        await upload(app, "second");
        expect(remote.puts.every((u) => u.startsWith("https://s3-b.test/"))).toBe(true);

        const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
        expect(await res.text()).toBe("needs-b");
    });

    it("设置了容量上限的存储用满后会被跳过", async () => {
        makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a", { priority: 10, quotaBytes: 10 }));
        await addStorage(app, s3Config("b", { priority: 5 }));
        await upload(app, "12345678", "1.png"); // 8 字节，进入 A
        await upload(app, "abcdefgh", "2.png"); // 再 8 字节会超过 10，进入 B
        const hosts = [...remote.objects.keys()].map((k) => new URL(k).host).sort();
        expect(hosts).toEqual(["s3-a.test", "s3-b.test"]);
    });

    it("所有自定义存储失败时回退到默认存储", async () => {
        const files = makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a"));
        remote.failPut = () => new Response("denied", { status: 403 });
        await upload(app, "fallback");
        expect(files.size).toBe(1);
    });

    it("支持 WebDAV 存储并支持 Range 读取（视频拖动进度条）", async () => {
        makeEnv();
        const app = buildApp();
        await addStorage(app, {
            name: "dav",
            type: "webdav",
            endpoint: "https://dav-main.test/remote.php/dav/files/me",
            accessKey: "me",
            secret: "pw",
            folder: "blog/media",
        });
        const url = await upload(app, "0123456789", "clip.mp4", "video/mp4");
        expect([...remote.objects.keys()][0]?.startsWith("https://dav-main.test/remote.php/dav/files/me/blog/media/")).toBe(true);

        const path = new URL(url).pathname.replace("/api", "");
        const res = await app.request(path, { headers: { Range: "bytes=2-5" } }, env);
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
        expect(await res.text()).toBe("2345");
        expect(res.headers.get("content-type")).toBe("video/mp4");
    });

    it("相同内容重复上传不会重复写入存储", async () => {
        makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a"));
        const first = await upload(app, "same-content");
        const second = await upload(app, "same-content");
        expect(second).toBe(first);
        expect(remote.puts).toHaveLength(1);
    });

    it("密钥加密存储，接口不会返回 secret", async () => {
        makeEnv();
        const app = buildApp();
        const created = await addStorage(app, s3Config("a"));
        expect(JSON.stringify(created)).not.toContain("SK-secret-value");
        expect(created.hasSecret).toBe(true);
        const row = sqlite.query("SELECT secret_enc FROM storages WHERE id = ?").get(created.id) as { secret_enc: string };
        expect(row.secret_enc.startsWith("v1:")).toBe(true);
        expect(row.secret_enc).not.toContain("SK-secret-value");
    });

    it("存储管理接口仅管理员可用", async () => {
        makeEnv();
        const app = buildApp({ admin: false });
        const res = await app.request("/storages", {}, env);
        expect(res.status).toBe(401);
    });

    it("还有文件的存储默认禁止删除，force 才能删除", async () => {
        makeEnv();
        const app = buildApp();
        const a = await addStorage(app, s3Config("a"));
        await upload(app, "x");
        const blocked = await app.request(`/storages/${a.id}`, { method: "DELETE" }, env);
        expect(blocked.status).toBe(409);
        const forced = await app.request(`/storages/${a.id}?force=1`, { method: "DELETE" }, env);
        expect(forced.status).toBe(200);
    });

    it("测试连接成功/失败都会给出结果", async () => {
        makeEnv();
        const app = buildApp();
        const ok = await app.request("/storages/test-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(s3Config("a")),
        }, env);
        expect(((await ok.json()) as any).ok).toBe(true);

        remote.failPut = () => new Response("nope", { status: 403 });
        const bad = await app.request("/storages/test-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(s3Config("a")),
        }, env);
        const body = (await bad.json()) as any;
        expect(body.ok).toBe(false);
        expect(body.error).toContain("403");
    });

    it("大文件预签名直传：presign → 浏览器 PUT → complete 后可读取", async () => {
        makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a"));

        const presign = await app.request("/storage/presign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "big.mp4", size: 5, type: "video/mp4" }),
        }, env);
        const plan = (await presign.json()) as any;
        expect(plan.mode).toBe("direct");
        expect(plan.url).toContain("X-Amz-Signature=");

        // 模拟浏览器直传
        const put = await fetch(plan.url, { method: "PUT", body: "hello" });
        expect(put.ok).toBe(true);

        const done = await app.request("/storage/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: plan.token }),
        }, env);
        expect(done.status).toBe(200);
        const { url } = (await done.json()) as any;
        const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
        expect(await res.text()).toBe("hello");
    });

    it("没有可直传的存储时 presign 返回 proxy 模式；complete 校验对象必须存在", async () => {
        makeEnv();
        const app = buildApp();
        const none = await app.request("/storage/presign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "big.mp4", size: 5 }),
        }, env);
        expect(((await none.json()) as any).mode).toBe("proxy");

        await addStorage(app, s3Config("a"));
        const presign = await app.request("/storage/presign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "big.mp4", size: 5 }),
        }, env);
        const plan = (await presign.json()) as any;
        const done = await app.request("/storage/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: plan.token }),
        }, env);
        expect(done.status).toBe(400); // 没有真的上传
    });

    it("HTML / SVG 文件强制下载，避免存储型 XSS", async () => {
        makeEnv();
        const app = buildApp();
        await addStorage(app, s3Config("a"));
        const url = await upload(app, "<script>alert(1)</script>", "evil.html", "text/html");
        const res = await app.request(new URL(url).pathname.replace("/api", ""), {}, env);
        expect(res.headers.get("content-disposition")).toContain("attachment");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
});
