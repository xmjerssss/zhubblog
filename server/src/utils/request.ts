import type { AppContext } from "../core/hono-types";

/** 取客户端 IP：Cloudflare 环境优先用 cf-connecting-ip。 */
export function clientIp(c: AppContext): string {
    return (
        c.req.header("cf-connecting-ip") ||
        c.req.header("x-real-ip") ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        "UNK"
    );
}
