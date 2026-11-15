import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, Variables } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { setJWTCookie } from "../core/hono-middleware";
import { users } from "../db/schema";
import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
    RateLimitError,
} from "../errors";
import { hashPassword, needsRehash, timingSafeEqualString, verifyPassword } from "../utils/password";
import { checkRateLimit, resetRateLimit } from "../utils/rate-limit";
import { clientIp } from "../utils/request";

// 登录相关的限流参数：同一 IP 15 分钟内最多 20 次尝试，
// 同一 IP + 用户名组合最多 10 次，用来挡住暴力破解。
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_IP_LIMIT = 20;
const LOGIN_USER_LIMIT = 10;

export function PasswordAuthService(): Hono<{
        Bindings: Env;
        Variables: Variables;
    }> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // Login with username and password
    app.post("/login", async (c: AppContext) => {
        const jwt = c.get('jwt');
        const db = c.get('db');
        const env = c.env;

        // Check if admin credentials are configured
        const adminUsername = env.ADMIN_USERNAME?.trim();
        const adminPassword = env.ADMIN_PASSWORD;

        if (!adminUsername || !adminPassword) {
            throw new BadRequestError('Admin credentials not configured');
        }

        const { username, password } = await profileAsync(c, 'auth_login_parse', () => c.req.json()) as { username: string; password: string };

        if (!username || !password) {
            throw new BadRequestError('Username and password are required');
        }

        const ip = clientIp(c);
        const ipLimit = await profileAsync(c, 'auth_rate_limit_ip', () => checkRateLimit(
            db,
            env,
            `login:ip:${ip}`,
            { limit: LOGIN_IP_LIMIT, windowSeconds: LOGIN_WINDOW_SECONDS },
        ));

        if (!ipLimit.allowed) {
            c.header('Retry-After', String(ipLimit.retryAfterSeconds));
            throw new RateLimitError(`Too many login attempts, please try again in ${ipLimit.retryAfterSeconds}s`);
        }

        const accountLimit = await profileAsync(c, 'auth_rate_limit_account', () => checkRateLimit(
            db,
            env,
            `login:account:${ip}:${username}`,
            { limit: LOGIN_USER_LIMIT, windowSeconds: LOGIN_WINDOW_SECONDS },
        ));

        if (!accountLimit.allowed) {
            c.header('Retry-After', String(accountLimit.retryAfterSeconds));
            throw new RateLimitError(`Too many login attempts, please try again in ${accountLimit.retryAfterSeconds}s`);
        }

        const issueSession = async (user: { id: number; username: string; avatar: string | null; permission: number | null }) => {
            await resetRateLimit(db, env, `login:account:${ip}:${username}`);

            const token = await profileAsync(c, 'auth_token_sign', () => jwt.sign({ id: user.id }));
            setJWTCookie(c, token);

            return c.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar,
                    permission: user.permission === 1,
                }
            });
        };

        // Check if this is the admin login.
        // 管理员凭据以环境变量为准，密码比较使用常量时间实现。
        if (username === adminUsername) {
            const passwordMatches = await profileAsync(c, 'auth_admin_verify', () => timingSafeEqualString(password, adminPassword));

            if (!passwordMatches) {
                throw new ForbiddenError('Invalid credentials');
            }

            let user = await profileAsync(c, 'auth_admin_lookup', () => db.query.users.findFirst({
                where: eq(users.openid, "admin")
            }));

            if (!user) {
                const passwordHash = await profileAsync(c, 'auth_admin_hash', () => hashPassword(adminPassword));
                const result = await profileAsync(c, 'auth_admin_insert', () => db.insert(users).values({
                    username: adminUsername,
                    openid: "admin",
                    avatar: "",
                    permission: 1,
                    password: passwordHash,
                }).returning({ insertedId: users.id }));

                if (!result || result.length === 0) {
                    throw new InternalServerError('Failed to create admin user');
                }

                user = await profileAsync(c, 'auth_admin_reload', () => db.query.users.findFirst({
                    where: eq(users.id, result[0].insertedId)
                }));
            } else if (user.username !== adminUsername || needsRehash(user.password)) {
                // 用户名或哈希算法变更后同步一次
                const passwordHash = await profileAsync(c, 'auth_admin_hash', () => hashPassword(adminPassword));
                await profileAsync(c, 'auth_admin_sync', () => db.update(users)
                    .set({ password: passwordHash, username: adminUsername })
                    .where(eq(users.id, user!.id)));
            }

            if (!user) {
                throw new InternalServerError('Failed to get admin user');
            }

            return issueSession(user);
        }

        // Regular user login
        const user = await profileAsync(c, 'auth_user_lookup', () => db.query.users.findFirst({
            where: eq(users.username, username)
        }));

        if (!user || !user.password) {
            throw new ForbiddenError('Invalid credentials');
        }

        const passwordMatches = await profileAsync(c, 'auth_user_verify', () => verifyPassword(password, user.password));

        if (!passwordMatches) {
            throw new ForbiddenError('Invalid credentials');
        }

        // 旧版单轮 SHA-256 哈希在登录成功后自动升级为 PBKDF2。
        if (needsRehash(user.password)) {
            const passwordHash = await profileAsync(c, 'auth_user_rehash', () => hashPassword(password));
            await profileAsync(c, 'auth_user_rehash_save', () => db.update(users)
                .set({ password: passwordHash })
                .where(eq(users.id, user.id)));
        }

        return issueSession(user);
    });

    // Check if password login is available
    app.get("/status", async (c: AppContext) => {
        const env = c.env;

        return c.json({
            github: !!(env.RIN_GITHUB_CLIENT_ID && env.RIN_GITHUB_CLIENT_SECRET),
            password: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
        });
    });

    return app;
}
