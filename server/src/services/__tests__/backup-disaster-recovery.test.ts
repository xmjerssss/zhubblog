import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BackupService } from "../backup";
import { setupTestApp, cleanupTestDB, createMockDB, createMockEnv, type TestContext } from "../../../tests/fixtures";
import { backupCrontab } from "../backup";
import type { Database } from "bun:sqlite";

const ADMIN_TOKEN = "Bearer mock_token_2";

/** 假对象存储：只认 cloudflarestorage 域名的读写请求。 */
class FakeBucket {
    objects = new Map<string, string>();
    install() {
        const original = globalThis.fetch;
        const stub = (async (input: any, init?: any) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = decodeURIComponent(request.url);
            if (!url.includes("cloudflarestorage")) return original(input, init);
            const key = new URL(request.url).pathname.replace(/^\/+/, "");
            if (request.method === "PUT") {
                this.objects.set(key, await request.text());
                return new Response(null, { status: 200 });
            }
            if (request.method === "HEAD") {
                return this.objects.has(key)
                    ? new Response(null, { status: 200 })
                    : new Response("not found", { status: 404 });
            }
            if (request.method === "DELETE") {
                this.objects.delete(key);
                return new Response(null, { status: 204 });
            }
            const body = this.objects.get(key);
            if (body === undefined) return new Response("not found", { status: 404 });
            return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        globalThis.fetch = stub;
        return () => {
            globalThis.fetch = original;
        };
    }
}

describe("灾难恢复：新账号 + 原存储桶", () => {
    let oldCtx: TestContext;
    let oldSqlite: Database;
    let newCtx: TestContext;
    let newSqlite: Database;
    let bucket: FakeBucket;
    let restoreFetch: () => void;

    beforeEach(async () => {
        bucket = new FakeBucket();
        restoreFetch = bucket.install();

        // 旧实例：正常跑了一段时间的博客
        oldCtx = await setupTestApp(BackupService);
        oldSqlite = oldCtx.sqlite;
        seedOldSite(oldSqlite);

        // 新实例：全新的库，storages 表是空的（还没加过任何存储）
        newCtx = await setupTestApp(BackupService);
        newSqlite = newCtx.sqlite;
        // 新账号里只有初始化时创建的站长账号，其余数据全空
        newSqlite.exec(`INSERT INTO users (id, username, avatar, openid, permission) VALUES (2, 'admin', '', 'admin', 1)`);
    });

    afterEach(() => {
        restoreFetch();
        if (oldSqlite) cleanupTestDB(oldSqlite);
        if (newSqlite) cleanupTestDB(newSqlite);
    });

    async function exportSnapshot(): Promise<any> {
        const res = await oldCtx.app.request("/export", {
            method: "GET",
            headers: { Authorization: ADMIN_TOKEN },
        }, oldCtx.env);
        expect(res.status).toBe(200);
        const payload = await res.json() as any;
        // 备份文件落在桶里，模拟云端备份
        bucket.objects.set("backups/rin-backup-2026-01-01.json", JSON.stringify(payload));
        return payload;
    }

    it("restores the whole site with only the bucket (no storage rows in DB)", async () => {
        await exportSnapshot();

        const storages = newSqlite.prepare("SELECT COUNT(*) as count FROM storages").get() as any;
        expect(storages.count).toBe(0);

        const res = await newCtx.app.request("/restore-from-storage", {
            method: "POST",
            headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ key: "backups/rin-backup-2026-01-01.json" }),
        }, newCtx.env);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.ok).toBe(true);
        expect(body.counts).toMatchObject({
            feeds: 2,
            comments: 1,
            moments: 1,
            friends: 1,
            users: 2,
            mediaFiles: 1,
            visits: 0,
        });

        // 内容真的写进库里了
        const feed = newSqlite.prepare("SELECT title FROM feeds ORDER BY id LIMIT 1").get() as any;
        expect(feed.title).toBe("Hello World");
        const config = newSqlite.prepare("SELECT value FROM cache WHERE key = 'site.title'").get() as any;
        expect(config.value).toBe("测试站点");
        const file = newSqlite.prepare("SELECT key FROM storage_files LIMIT 1").get() as any;
        expect(file.key).toBe("images/photo.png");
    });

    it("writes a pre-restore snapshot into the bucket before overwriting", async () => {
        await exportSnapshot();

        // 新实例已经有一些自己的数据，恢复应先把它们备份进桶
        newSqlite.exec(`INSERT INTO feeds (id, title, alias, content, uid) VALUES (99, 'New Site', 'new', 'x', 2)`);

        const res = await newCtx.app.request("/restore-from-storage", {
            method: "POST",
            headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ key: "backups/rin-backup-2026-01-01.json" }),
        }, newCtx.env);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.safetyBackup).toBe("backups/pre-restore.json");

        const safety = JSON.parse(bucket.objects.get("backups/pre-restore.json")!) as any;
        expect(safety.app).toBe("rin");
        expect(safety.data.feeds.map((row: any) => row.title)).toEqual(["New Site"]);
    });

    it("keeps working when restored storage secrets cannot be decrypted", async () => {
        const payload = await exportSnapshot();
        // 旧账号用旧 JWT_SECRET 加密的密钥，新账号解不开
        bucket.objects.set(
            "backups/rin-backup-2026-01-01.json",
            JSON.stringify({
                ...payload,
                data: {
                    ...payload.data,
                    storages: payload.data.storages.map((row: any) => ({
                        ...row,
                        secretEnc: "v1:broken:broken",
                    })),
                },
            }),
        );

        const res = await newCtx.app.request("/restore-from-storage", {
            method: "POST",
            headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ key: "backups/rin-backup-2026-01-01.json" }),
        }, newCtx.env);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        // 有明确的提示，让用户去存储管理重填密钥
        expect(body.warnings.join("\n")).toContain("无法解密");

        // 恢复后仍然可以正常读桶（坏存储行被跳过，回退到环境变量默认存储）
        const list = await newCtx.app.request("/storage-list", {
            method: "GET",
            headers: { Authorization: ADMIN_TOKEN },
        }, newCtx.env);
        expect(list.status).toBe(200);
        expect((await list.json() as any).ok).toBe(true);
    });

    it("keeps the current operator as admin even if the backup has other admins", async () => {
        await exportSnapshot();

        // 新账号是用另一个 GitHub 账号登录的，旧备份里没有这个人
        newSqlite.exec(`UPDATE users SET openid = 'gh_new_owner', username = 'new-owner', permission = 0 WHERE id = 2`);
        newSqlite.exec(`UPDATE users SET permission = 1 WHERE id = 2`);

        const res = await newCtx.app.request("/restore-from-storage", {
            method: "POST",
            headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ key: "backups/rin-backup-2026-01-01.json" }),
        }, newCtx.env);

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.warnings.join("\n")).toContain("已把你的账号一并设为管理员");

        const operator = newSqlite
            .prepare("SELECT permission FROM users WHERE openid = 'gh_new_owner'")
            .get() as any;
        expect(operator?.permission).toBe(1);

        // 旧站点的管理员也还在
        const admins = newSqlite.prepare("SELECT COUNT(*) as count FROM users WHERE permission = 1").get() as any;
        expect(admins.count).toBe(2);
    });

    it("rejects a broken snapshot before touching existing data", async () => {
        bucket.objects.set("backups/broken.json", JSON.stringify({ app: "not-rin" }));
        newSqlite.exec(`INSERT INTO feeds (id, title, alias, content, uid) VALUES (42, 'Keep Me', 'keep', 'x', 2)`);

        const res = await newCtx.app.request("/restore-from-storage", {
            method: "POST",
            headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ key: "backups/broken.json" }),
        }, newCtx.env);

        expect(res.status).toBe(500);
        const feeds = newSqlite.prepare("SELECT title FROM feeds").all() as any[];
        expect(feeds.map((row) => row.title)).toEqual(["Keep Me"]);
    });
});

function seedOldSite(sqlite: Database) {
    sqlite.exec(`
        INSERT INTO users (id, username, avatar, openid, permission) VALUES
            (1, 'reader', 'reader.png', 'gh_1', 0),
            (2, 'admin', 'admin.png', 'admin', 1);

        INSERT INTO feeds (id, title, alias, content, uid, draft, listed, created_at) VALUES
            (1, 'Hello World', 'hello', '# Hi', 2, 0, 1, 1700000000),
            (2, 'Second', 'second', 'body', 2, 0, 1, 1700000100);

        INSERT INTO hashtags (id, name) VALUES (1, 'tag');
        INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (1, 1);

        INSERT INTO comments (id, feed_id, user_id, content) VALUES (1, 1, 1, 'nice');
        INSERT INTO moments (id, content, uid) VALUES (1, 'a moment', 2);
        INSERT INTO friends (id, name, avatar, url, uid) VALUES (1, 'Friend', 'f.png', 'https://friend.dev', 2);

        INSERT INTO storages (id, name, type, endpoint, bucket, access_key, secret_enc, status, enabled) VALUES
            (1, 'R2', 'r2', 'https://acc.r2.cloudflarestorage.com', 'blog-bucket', 'ak', 'v1:aaaa:bbbb', 'ok', 1);

        INSERT INTO storage_files (key, storage_id, object_key, name, mime, size) VALUES
            ('images/photo.png', 1, 'images/photo.png', 'photo.png', 'image/png', 1024);

        INSERT INTO cache (id, key, value, type) VALUES
            (1, 'site.title', '测试站点', 'client.config');
    `);
}

describe("自动备份（定时任务）", () => {
    let bucket: FakeBucket;
    let restoreFetch: () => void;
    let sqlite: Database;
    let db: any;
    let env: Env;
    let store: Map<string, any>;
    let serverConfig: { get: (key: string) => Promise<any>; set: (key: string, value: any) => Promise<void> };

    beforeEach(() => {
        bucket = new FakeBucket();
        restoreFetch = bucket.install();
        const mock = createMockDB();
        db = mock.db;
        sqlite = mock.sqlite;
        env = createMockEnv();
        store = new Map();
        serverConfig = {
            get: async (key: string) => store.get(key),
            set: async (key: string, value: any) => {
                store.set(key, value);
            },
        };
        sqlite.exec(`
            INSERT INTO users (id, username, openid, permission) VALUES (2, 'admin', 'admin', 1);
            INSERT INTO feeds (id, title, alias, content, uid) VALUES (1, '文章', 'a', '正文', 2);
        `);
    });

    afterEach(() => {
        restoreFetch();
        cleanupTestDB(sqlite);
    });

    it("writes a snapshot to the bucket once per interval", async () => {
        const first = await backupCrontab(env, db, serverConfig);
        expect("key" in first).toBe(true);

        const backups = [...bucket.objects.keys()].filter((key) => key.includes("rin-backup-"));
        expect(backups).toHaveLength(1);
        const payload = JSON.parse(bucket.objects.get(backups[0])!) as any;
        expect(payload.data.feeds).toHaveLength(1);

        // 同一天再跑一次不会重复写
        const second = await backupCrontab(env, db, serverConfig);
        expect(second).toEqual({ skipped: "not-due" });
        expect([...bucket.objects.keys()].filter((key) => key.includes("rin-backup-"))).toHaveLength(1);
    });

    it("keeps only the newest backups", async () => {
        bucket.objects.set("backups/index.json", JSON.stringify([
            { key: "backups/rin-backup-old1.json", filename: "rin-backup-old1.json" },
            { key: "backups/rin-backup-old2.json", filename: "rin-backup-old2.json" },
            { key: "backups/rin-backup-old3.json", filename: "rin-backup-old3.json" },
        ]));
        bucket.objects.set("backups/rin-backup-old3.json", "{}");

        await backupCrontab(env, db, serverConfig);

        const index = JSON.parse(bucket.objects.get("backups/index.json")!) as any[];
        expect(index).toHaveLength(3);
        expect(bucket.objects.has("backups/rin-backup-old3.json")).toBe(false);
    });

    it("can be disabled and skips silently without storage", async () => {
        store.set("backup_auto_interval_hours", 0);
        expect(await backupCrontab(env, db, serverConfig)).toEqual({ skipped: "disabled" });

        store.clear();
        const noStorageEnv = createMockEnv({
            S3_ENDPOINT: "",
            S3_ACCESS_KEY_ID: "",
            S3_SECRET_ACCESS_KEY: "",
            S3_BUCKET: "",
        } as any);
        expect(await backupCrontab(noStorageEnv, db, serverConfig)).toEqual({ skipped: "no-storage" });
    });
});
