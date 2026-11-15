import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { and, desc, eq } from "drizzle-orm";
import { comments, feeds, users } from "../db/schema";
import { adminOnly } from "../core/route-boundaries";
import { profileAsync } from "../core/server-timing";
import { notify } from "../utils/webhook";
import { resolveWebhookConfig } from "./config-helpers";

const COMMENT_MAX_LENGTH = 5000;
const GUEST_NAME_MAX_LENGTH = 50;
const GUEST_EMAIL_MAX_LENGTH = 254;
const GUEST_WEBSITE_MAX_LENGTH = 2048;

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

export function CommentService(): Hono {
    const app = new Hono();

    // 待审核列表（必须先于 /:feed 注册，否则会被当成文章 id）
    app.get('/pending', adminOnly(async (c: AppContext) => {
        const db = c.get('db');

        const pending = await profileAsync(c, 'comment_pending_db', () => db.query.comments.findMany({
            where: eq(comments.approved, 0),
            with: {
                user: { columns: { id: true, username: true, avatar: true, permission: true } },
                feed: { columns: { id: true, title: true, alias: true } },
            },
            orderBy: [desc(comments.createdAt)],
        }));

        return c.json(pending);
    }));

    app.get('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const admin = c.get('admin');
        const feedId = parseInt(c.req.param('feed'));

        // 未审核的评论只有管理员能看到，其他人等审核通过后再显示
        const where = admin
            ? eq(comments.feedId, feedId)
            : and(eq(comments.feedId, feedId), eq(comments.approved, 1));

        const comment_list = await profileAsync(c, 'comment_list_db', () => db.query.comments.findMany({
            where,
            columns: { feedId: false, userId: false },
            with: {
                user: {
                    columns: { id: true, username: true, avatar: true, permission: true }
                }
            },
            orderBy: [desc(comments.createdAt)]
        }));
        
        // 公开接口不返回游客邮箱：前端只用 guestName，邮箱属于隐私数据。
        const result = comment_list.map((c: any) => {
            const { guestEmail: _guestEmail, ...rest } = c;
            if (rest.user) {
                return rest;
            }
            return {
                ...rest,
                user: null,
                guestName: rest.guestName || "",
                guestWebsite: rest.guestWebsite || "",
            };
        });
        
        return c.json(result);
    });

    app.post('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const env = c.get('env');
        const serverConfig = c.get('serverConfig');
        const uid = c.get('uid');
        const admin = c.get('admin');
        const requireApproval = Boolean(await c.get('serverConfig').get('comment.require_approval'));
        const needsApproval = requireApproval && !admin;
        const feedId = parseInt(c.req.param('feed'));
        const body = await profileAsync(c, 'comment_create_parse', () => c.req.json()) as {
            content?: unknown;
            guestName?: unknown;
            guestEmail?: unknown;
            guestWebsite?: unknown;
        } | null;

        const content = typeof body?.content === 'string' ? body.content.trim() : '';
        const guestName = typeof body?.guestName === 'string' ? body.guestName.trim() : '';
        const guestEmail = typeof body?.guestEmail === 'string' ? body.guestEmail.trim() : '';
        const guestWebsite = typeof body?.guestWebsite === 'string' ? body.guestWebsite.trim() : '';

        if (!content) {
            return c.text('Content is required', 400);
        }

        // 输入长度上限，避免超长内容撑爆数据库 / 通知渠道
        if (content.length > COMMENT_MAX_LENGTH) {
            return c.text(`Content is too long (max ${COMMENT_MAX_LENGTH} characters)`, 400);
        }
        if (guestName.length > GUEST_NAME_MAX_LENGTH) {
            return c.text(`Guest name is too long (max ${GUEST_NAME_MAX_LENGTH} characters)`, 400);
        }
        if (guestEmail.length > GUEST_EMAIL_MAX_LENGTH) {
            return c.text('Guest email is too long', 400);
        }
        if (guestWebsite && !isHttpUrl(guestWebsite)) {
            return c.text('Guest website must be a valid http(s) URL', 400);
        }
        if (guestWebsite.length > GUEST_WEBSITE_MAX_LENGTH) {
            return c.text('Guest website is too long', 400);
        }
        
        const exist = await profileAsync(c, 'comment_create_feed', () => db.query.feeds.findFirst({ where: eq(feeds.id, feedId) }));
        if (!exist) {
            return c.text('Feed not found', 400);
        }

        // 如果该文章关闭了评论，直接拦截提交
        if (exist.content.includes('hide-comment')) {
            return c.text('Comments are disabled for this post', 403);
        }

        // 登录用户评论
        if (uid) {
            const user = await profileAsync(c, 'comment_create_user', () => db.query.users.findFirst({ where: eq(users.id, uid) }));
            if (!user) {
                return c.text('User not found', 400);
            }

            await db.insert(comments).values({
                feedId,
                userId: uid,
                content,
                approved: needsApproval ? 0 : 1,
            });

            const { webhookUrl, webhookMethod, webhookContentType, webhookHeaders, webhookBodyTemplate } =
                await profileAsync(c, 'comment_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
            const frontendUrl = new URL(c.req.url).origin;
            try {
                await profileAsync(c, 'comment_create_notify', () => notify(
                    webhookUrl || "",
                    {
                        event: "comment.created",
                        message: `${frontendUrl}/feed/${feedId}\n${needsApproval ? "[待审核] " : ""}${user.username} 评论了: ${exist.title}\n${content}`,
                        title: exist.title || "",
                        url: `${frontendUrl}/feed/${feedId}`,
                        username: user.username,
                        content,
                    },
                    {
                        method: webhookMethod,
                        contentType: webhookContentType,
                        headers: webhookHeaders,
                        bodyTemplate: webhookBodyTemplate,
                    },
                ));
            } catch (error) {
                console.error("Failed to send comment webhook", error);
            }
            return c.text(needsApproval ? 'Pending approval' : 'OK');
        }

        // 游客评论
        if (!guestName) {
            return c.text('Guest name is required', 400);
        }

        await db.insert(comments).values({
            feedId,
            userId: null,
            content,
            guestName,
            guestEmail,
            guestWebsite,
            approved: needsApproval ? 0 : 1,
        });

        const { webhookUrl, webhookMethod, webhookContentType, webhookHeaders, webhookBodyTemplate } =
            await profileAsync(c, 'comment_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
        const frontendUrl = new URL(c.req.url).origin;
        try {
            await profileAsync(c, 'comment_create_notify', () => notify(
                webhookUrl || "",
                {
                    event: "comment.created",
                    message: `${frontendUrl}/feed/${feedId}\n${needsApproval ? "[待审核] " : ""}游客 ${guestName} 评论了: ${exist.title}\n${content}`,
                    title: exist.title || "",
                    url: `${frontendUrl}/feed/${feedId}`,
                    username: guestName,
                    content,
                },
                {
                    method: webhookMethod,
                    contentType: webhookContentType,
                    headers: webhookHeaders,
                    bodyTemplate: webhookBodyTemplate,
                },
            ));
        } catch (error) {
            console.error("Failed to send comment webhook", error);
        }
        return c.text(needsApproval ? 'Pending approval' : 'OK');
    });

    // 审核通过：只有管理员能操作
    app.patch('/:id/approve', adminOnly(async (c: AppContext) => {
        const db = c.get('db');
        const id = parseInt(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.text('Invalid comment id', 400);
        }

        const comment = await profileAsync(c, 'comment_approve_lookup', () => db.query.comments.findFirst({ where: eq(comments.id, id) }));
        if (!comment) {
            return c.text('Not found', 404);
        }

        await db.update(comments).set({ approved: 1 }).where(eq(comments.id, id));
        return c.text('OK');
    }));

    app.delete('/:id', async (c: AppContext) => {
        const db = c.get('db');
        const uid = c.get('uid');
        const admin = c.get('admin');
        
        if (uid === undefined) {
            return c.text('Unauthorized', 401);
        }
        
        const id_num = parseInt(c.req.param('id'));
        const comment = await profileAsync(c, 'comment_delete_lookup', () => db.query.comments.findFirst({ where: eq(comments.id, id_num) }));
        
        if (!comment) {
            return c.text('Not found', 404);
        }
        
        if (admin) {
            await db.delete(comments).where(eq(comments.id, id_num));
            return c.text('OK');
        }
        
        if (comment.userId !== uid) {
            return c.text('Permission denied', 403);
        }
        
        await db.delete(comments).where(eq(comments.id, id_num));
        return c.text('OK');
    });

    return app;
}
