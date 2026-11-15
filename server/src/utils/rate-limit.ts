import type { DB } from "../core/hono-types";
import { CacheImpl } from "./cache";

export interface RateLimitOptions {
    /** 时间窗口内允许的最大请求次数 */
    limit: number;
    /** 时间窗口长度（秒） */
    windowSeconds: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

interface RateLimitBucket {
    count: number;
    resetAt: number;
}

// 限流计数放在独立的 cache 命名空间里，并且强制使用数据库存储：
// 这样即使站点未启用 S3 缓存也能工作，也不会污染面向公众的缓存。
const STORE_TYPE = "auth";

/**
 * 基于 D1 的朴素计数器限流。用于登录等敏感入口，抵御暴力破解。
 *
 * Cloudflare Workers 实例之间不共享内存，因此计数必须落库；这里复用现有的
 * cache 表实现，读写都是单条记录，成本很低。并发场景下计数可能有一两个的误差，
 * 对于限流目的足够。
 */
export async function checkRateLimit(
    db: DB,
    env: Env,
    key: string,
    options: RateLimitOptions,
): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = options.windowSeconds * 1000;

    try {
        const store = new CacheImpl(db, env, STORE_TYPE, "database");
        const cached = await store.get(key) as RateLimitBucket | undefined;

        if (!cached || typeof cached.resetAt !== "number" || cached.resetAt <= now) {
            const bucket: RateLimitBucket = { count: 1, resetAt: now + windowMs };
            await store.set(key, bucket);
            return { allowed: true, remaining: Math.max(0, options.limit - 1), retryAfterSeconds: 0 };
        }

        if (cached.count >= options.limit) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((cached.resetAt - now) / 1000)),
            };
        }

        const bucket: RateLimitBucket = { count: cached.count + 1, resetAt: cached.resetAt };
        await store.set(key, bucket);
        return { allowed: true, remaining: Math.max(0, options.limit - bucket.count), retryAfterSeconds: 0 };
    } catch (error) {
        // 限流组件本身故障时不应把用户挡在门外，但要留下日志。
        console.error("Rate limit check failed", error);
        return { allowed: true, remaining: options.limit, retryAfterSeconds: 0 };
    }
}

/** 登录失败后清空计数（登录成功时调用），避免正常用户被自己上一次的失败次数影响。 */
export async function resetRateLimit(db: DB, env: Env, key: string): Promise<void> {
    try {
        const store = new CacheImpl(db, env, STORE_TYPE, "database");
        await store.delete(key);
    } catch (error) {
        console.error("Rate limit reset failed", error);
    }
}
