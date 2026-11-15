import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { setJWTCookie } from "../core/hono-middleware";
import { users } from "../db/schema";
import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
    NotFoundError
} from "../errors";
import { parseConfiguredOrigins, isTrustedFrontendUrl } from "../utils/origin";
import { timingSafeEqualString } from "../utils/password";

const OAUTH_COOKIE_MAX_AGE = 10 * 60;

function isSecureRequest(c: AppContext): boolean {
    try {
        return new URL(c.req.url).protocol === 'https:';
    } catch {
        return false;
    }
}

export function UserService(): Hono {
    const app = new Hono();

    // GET /user/github - Redirect to GitHub OAuth
    app.get("/github", async (c: AppContext) => {
        const oauth2 = c.get('oauth2');

        if (!oauth2) {
            throw new BadRequestError('GitHub OAuth is not configured');
        }

        // 回跳地址只能落在可信前端上：请求自身的主机名、FRONTEND_URL 配置或本地开发地址。
        // 之前这里直接使用任意 Referer 的 origin，配合回调把 token 拼进 URL，
        // 会让第三方站点拿到登录令牌（开放重定向 + 账号接管）。
        const requestUrl = c.req.url;
        const referer = c.req.header('referer');
        const configuredOrigin = parseConfiguredOrigins(c.env.FRONTEND_URL)[0];
        const requestOrigin = new URL(requestUrl).origin;

        let redirectOrigin = configuredOrigin ?? requestOrigin;
        if (referer) {
            try {
                const refererUrl = new URL(referer);
                if (isTrustedFrontendUrl(refererUrl.origin, {
                    requestUrl,
                    frontendUrl: c.env.FRONTEND_URL,
                })) {
                    redirectOrigin = refererUrl.origin;
                }
            } catch {
                // Referer 非法时回落到默认来源
            }
        }

        setCookie(c, 'redirect_to', redirectOrigin, {
            path: '/',
            httpOnly: true,
            secure: isSecureRequest(c),
            sameSite: 'Lax',
            maxAge: OAUTH_COOKIE_MAX_AGE,
        });

        const genState = await profileAsync(c, 'user_oauth_state', () => Promise.resolve(oauth2.generateState()));
        setCookie(c, 'state', genState, {
            path: '/',
            httpOnly: true,
            secure: isSecureRequest(c),
            sameSite: 'Lax',
            maxAge: OAUTH_COOKIE_MAX_AGE,
        });

        return c.redirect(oauth2.createRedirectUrl(genState, "GitHub"), 302);
    });

    // GET /user/github/callback - GitHub OAuth callback
    app.get("/github/callback", async (c: AppContext) => {
        const oauth2 = c.get('oauth2');
        const jwt = c.get('jwt');
        const db = c.get('db');

        if (!oauth2) {
            throw new BadRequestError('GitHub OAuth is not configured');
        }

        const query = c.req.query();
        const stateCookie = getCookie(c, 'state');

        // Verify state to prevent CSRF attacks（常量时间比较）
        if (!query.state || !stateCookie || !(await timingSafeEqualString(query.state, stateCookie))) {
            throw new BadRequestError('Invalid state parameter');
        }

        // Clear state cookie
        deleteCookie(c, 'state', { path: '/' });

        // Exchange code for access token
        const gh_token = await profileAsync(c, 'user_oauth_authorize', () => oauth2.authorize("GitHub", query.code));
        if (!gh_token) {
            throw new BadRequestError('Failed to authorize with GitHub');
        }

        // Request https://api.github.com/user for user info
        const response = await profileAsync(c, 'user_github_fetch', () => fetch("https://api.github.com/user", {
            headers: {
                Authorization: `Bearer ${gh_token.accessToken}`,
                Accept: "application/json",
                "User-Agent": "rin"
            },
        }));

        const user: any = await profileAsync(c, 'user_github_parse', () => response.json());
        const profile: {
            openid: string;
            username: string;
            avatar: string;
            permission: number | null;
        } = {
            openid: user.id,
            username: user.name || user.login,
            avatar: user.avatar_url,
            permission: 0
        };

        // Check if user exists
        const existingUser = await profileAsync(c, 'user_existing_lookup', () => db.query.users.findFirst({
            where: eq(users.openid, profile.openid)
        }));

        let userId: number;

        if (existingUser) {
            profile.permission = existingUser.permission;
            await profileAsync(c, 'user_existing_update', () => db.update(users).set(profile).where(eq(users.id, existingUser.id)));
            userId = existingUser.id;
        } else {
            // If no user exists, check if this is the first user
            const anyUserCheck = await profileAsync(c, 'user_first_lookup', () => db.query.users.findMany({ limit: 1 }));
            if (anyUserCheck.length === 0) {
                profile.permission = 1;
            }

            const result = await profileAsync(c, 'user_insert', () => db.insert(users).values(profile).returning({ insertedId: users.id }));
            if (!result || result.length === 0) {
                throw new InternalServerError('Failed to register user');
            }

            userId = result[0].insertedId;
        }

        // 只下发 HttpOnly cookie：不再额外写一个 JS 可读的 auth_token，
        // 也不再通过 URL 传递 token（会被浏览器历史、Referer、统计脚本带走）。
        const authToken = await profileAsync(c, 'user_issue_token', () => jwt.sign({ id: userId }));
        setJWTCookie(c, authToken);

        // 回跳目标再次校验，确保只回到可信前端
        const redirectTo = getCookie(c, 'redirect_to');
        const requestOrigin = new URL(c.req.url).origin;
        let targetOrigin = parseConfiguredOrigins(c.env.FRONTEND_URL)[0] ?? requestOrigin;

        if (redirectTo && isTrustedFrontendUrl(redirectTo, {
            requestUrl: c.req.url,
            frontendUrl: c.env.FRONTEND_URL,
        })) {
            try {
                targetOrigin = new URL(redirectTo).origin;
            } catch {
                // 配置异常时回落到默认来源
            }
        }

        deleteCookie(c, 'redirect_to', { path: '/' });

        return c.redirect(new URL('/callback', targetOrigin).toString(), 302);
    });

    // GET /user/profile - Get user profile
    app.get('/profile', async (c: AppContext) => {
        const uid = c.get('uid');
        const db = c.get('db');

        if (!uid) {
            throw new ForbiddenError('Authentication required');
        }

        const user = await profileAsync(c, 'user_profile_lookup', () => db.query.users.findFirst({ where: eq(users.id, uid) }));
        if (!user) {
            throw new NotFoundError('User');
        }

        return c.json({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            permission: user.permission === 1,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        });
    });

    // POST /user/logout - Logout user
    app.post('/logout', async (c: AppContext) => {
        deleteCookie(c, 'token', {
            path: '/',
            httpOnly: true,
            secure: isSecureRequest(c),
            sameSite: 'Lax',
        });
        // 清理历史版本遗留的 JS 可读 cookie
        deleteCookie(c, 'auth_token', {
            path: '/',
            sameSite: 'Lax',
        });
        return c.json({ success: true });
    });

    // PUT /user/profile - Update user profile
    app.put('/profile', async (c: AppContext) => {
        const uid = c.get('uid');
        const db = c.get('db');
        const body = await profileAsync(c, 'user_profile_parse', () => c.req.json());

        if (!uid) {
            throw new ForbiddenError('Authentication required');
        }

        const { username, avatar } = body as { username?: string; avatar?: string };

        if (!username && !avatar) {
            throw new BadRequestError('At least one field (username or avatar) is required');
        }

        const updateData: { username?: string; avatar?: string } = {};
        if (username !== undefined) {
            const trimmed = String(username).trim();
            if (!trimmed) {
                throw new BadRequestError('Username cannot be empty');
            }
            if (trimmed.length > 50) {
                throw new BadRequestError('Username is too long (max 50 characters)');
            }
            updateData.username = trimmed;
        }
        if (avatar !== undefined) {
            const trimmed = String(avatar).trim();
            if (trimmed.length > 2048) {
                throw new BadRequestError('Avatar URL is too long');
            }
            updateData.avatar = trimmed;
        }

        if (Object.keys(updateData).length === 0) {
            throw new BadRequestError('At least one field (username or avatar) is required');
        }

        await profileAsync(c, 'user_profile_update', () => db.update(users).set(updateData).where(eq(users.id, uid)));

        return c.json({ success: true });
    });

    return app;
}
