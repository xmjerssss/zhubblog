import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BackupService } from "../backup";
import {
    setupTestApp,
    cleanupTestDB,
    type TestContext,
} from "../../../tests/fixtures";
import type { Database } from "bun:sqlite";

const ADMIN_TOKEN = "Bearer mock_token_2";

describe("BackupService", () => {
    let ctx: TestContext;
    let sqlite: Database;

    beforeEach(async () => {
        ctx = await setupTestApp(BackupService);
        sqlite = ctx.sqlite;
        seed(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function exportBackup(): Promise<any> {
        const res = await ctx.app.request("/export", {
            method: "GET",
            headers: { Authorization: ADMIN_TOKEN },
        }, ctx.env);

        expect(res.status).toBe(200);
        return JSON.parse(await res.text());
    }

    async function importBackup(payload: any): Promise<Response> {
        return ctx.app.request("/import", {
            method: "POST",
            headers: {
                Authorization: ADMIN_TOKEN,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }, ctx.env);
    }

    it("exports every table needed for a full restore", async () => {
        const payload = await exportBackup();

        expect(payload.app).toBe("rin");
        expect(payload.version).toBeGreaterThanOrEqual(1);

        for (const table of [
            "users",
            "feeds",
            "moments",
            "friends",
            "comments",
            "hashtags",
            "feedHashtags",
            "configs",
            "storages",
            "storageFiles",
            "visitStats",
        ]) {
            expect(payload.data).toHaveProperty(table);
        }

        expect(payload.data.feeds).toHaveLength(2);
        expect(payload.data.configs.length).toBe(2);
        // 站点配置必须进备份，否则换账号恢复后站点标题/主题会丢
        const configKeys = payload.data.configs.map((row: any) => row.key);
        expect(configKeys).toContain("site.title");
    });

    it("restores a snapshot into a database that already has cache rows", async () => {
        const payload = await exportBackup();

        // 模拟“运行了一段时间”的实例：cache 表里堆了若干公共缓存行，
        // 且它们的自增 id 与备份里配置行的 id 重叠。
        sqlite.exec(`
            DELETE FROM cache;
            INSERT INTO cache (id, key, value, type) VALUES
                (1, 'feeds_undefined_0_20_public', '{"size":0,"data":[],"hasNext":false}', 'cache'),
                (2, 'moments_0_20', '{"size":0,"data":[],"hasNext":false}', 'cache'),
                (3, 'search_x_0_20_a', '{}', 'cache');
        `);

        const res = await importBackup(payload);
        expect(res.status).toBe(200);

        const body = await res.json() as any;
        expect(body.ok).toBe(true);
        expect(body.counts.feeds).toBe(2);

        // 配置行被完整恢复
        const configs = sqlite.prepare("SELECT key, value, type FROM cache WHERE type IN ('client.config','server.config')").all() as any[];
        expect(configs.length).toBe(2);
        expect(configs.some((row) => row.key === "site.title")).toBe(true);
    });

    it("restores data and drops rows added after the snapshot", async () => {
        const payload = await exportBackup();

        sqlite.exec(`
            INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (99, 'Added later', 'x', 1, 0, 1);
        `);

        const res = await importBackup(payload);
        expect(res.status).toBe(200);

        const feeds = sqlite.prepare("SELECT id, title FROM feeds ORDER BY id").all() as any[];
        expect(feeds.map((feed) => feed.title)).toEqual(["备份文章一", "备份文章二"]);
        expect(feeds.some((feed) => feed.id === 99)).toBe(false);

        // 关联数据也要一起回来
        const relations = sqlite.prepare("SELECT * FROM feed_hashtags").all() as any[];
        expect(relations.length).toBe(1);
        const comments = sqlite.prepare("SELECT content FROM comments").all() as any[];
        expect(comments.map((row) => row.content)).toEqual(["第一条评论"]);
        const moments = sqlite.prepare("SELECT content FROM moments").all() as any[];
        expect(moments).toHaveLength(1);
        const friends = sqlite.prepare("SELECT name FROM friends").all() as any[];
        expect(friends.map((row) => row.name)).toEqual(["友链 A"]);
        const stats = sqlite.prepare("SELECT feed_id, pv FROM visit_stats").all() as any[];
        expect(stats).toEqual([{ feed_id: 1, pv: 42 }]);
    });

    it("rejects invalid payloads without touching existing data", async () => {
        const res = await importBackup({ app: "not-rin", data: {} });

        expect(res.status).toBe(500);
        const body = await res.json() as any;
        expect(body.ok).toBe(false);

        // 原有数据仍在
        const feeds = sqlite.prepare("SELECT COUNT(*) as count FROM feeds").get() as any;
        expect(feeds.count).toBe(2);
    });

    it("replaces visit history with the snapshot instead of keeping stale rows", async () => {
        // 快照里带上两条访问记录
        sqlite.exec(`INSERT INTO visits (feed_id, ip) VALUES (1, 'hash1'), (1, 'hash2')`);
        const payload = await exportBackup();

        // 快照之后又产生了新的访问记录，恢复后应被快照内容覆盖
        sqlite.exec(`INSERT INTO visits (feed_id, ip) VALUES (1, 'hash3'), (2, 'hash4')`);

        const res = await importBackup(payload);
        expect(res.status).toBe(200);

        const visits = sqlite.prepare("SELECT ip FROM visits ORDER BY ip").all() as any[];
        expect(visits.map((row) => row.ip)).toEqual(["hash1", "hash2"]);

        const body = await res.json() as any;
        expect(body.counts.visits).toBe(2);
    });

    it("returns counts read back from the database", async () => {
        const payload = await exportBackup();
        const res = await importBackup(payload);
        const body = await res.json() as any;

        expect(body.counts).toMatchObject({
            feeds: 2,
            comments: 1,
            moments: 1,
            friends: 1,
            users: 2,
            mediaFiles: 1,
        });
    });

    it("only allows admins to export or import", async () => {
        const exportRes = await ctx.app.request("/export", {
            method: "GET",
            headers: { Authorization: "Bearer mock_token_1" },
        }, ctx.env);
        expect([401, 403]).toContain(exportRes.status);

        const importRes = await ctx.app.request("/import", {
            method: "POST",
            headers: { Authorization: "Bearer mock_token_1", "Content-Type": "application/json" },
            body: JSON.stringify({ app: "rin", data: {} }),
        }, ctx.env);
        expect([401, 403]).toContain(importRes.status);
    });
});

function seed(sqlite: Database) {
    sqlite.exec(`
        INSERT INTO users (id, username, avatar, openid, permission) VALUES
            (1, 'reader', 'reader.png', 'gh_1', 0),
            (2, 'admin', 'admin.png', 'admin', 1);

        INSERT INTO feeds (id, title, alias, content, uid, draft, listed, created_at) VALUES
            (1, '备份文章一', 'first', '正文一', 2, 0, 1, 1700000000),
            (2, '备份文章二', 'second', '正文二', 2, 0, 1, 1700000100);

        INSERT INTO hashtags (id, name) VALUES (1, 'backup');
        INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (1, 1);

        INSERT INTO comments (id, feed_id, user_id, content) VALUES (1, 1, 1, '第一条评论');
        INSERT INTO moments (id, content, uid) VALUES (1, '一条动态', 2);
        INSERT INTO friends (id, name, avatar, url, uid) VALUES (1, '友链 A', 'a.png', 'https://a.example.com', 2);

        INSERT INTO visit_stats (feed_id, pv, hll_data) VALUES (1, 42, 'hll');

        INSERT INTO storages (id, name, type, endpoint, bucket, access_key, secret_enc)
            VALUES (1, '我的 R2', 'r2', 'https://acc.r2.cloudflarestorage.com', 'blog', 'ak', 'v1:enc');

        INSERT INTO storage_files (key, storage_id, object_key, name, mime, size)
            VALUES ('images/a.png', 1, 'images/a.png', 'a.png', 'image/png', 1024);

        INSERT INTO cache (id, key, value, type) VALUES
            (1, 'site.title', '备份站', 'client.config'),
            (2, 'ai.apiKey', 'secret', 'server.config');
    `);
}
