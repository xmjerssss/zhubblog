// 站点来源白名单工具。
//
// 历史上服务端会把任意 Origin 原样反射回去（CORS），并用任意 Referer 拼 OAuth 回跳地址，
// 这两处都会被第三方站点利用。这里统一提供白名单判断：
//   - 与请求同源；
//   - 与请求同主机名（允许本地开发时前端 5173、后端 11498 这种不同端口）；
//   - 命中 FRONTEND_URL 配置（支持逗号分隔多个）；
//   - 本地开发地址（localhost / 127.0.0.1）。

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 解析 FRONTEND_URL，支持逗号分隔的多个地址。 */
export function parseConfiguredOrigins(value?: string | null): string[] {
    if (!value) return [];

    const result: string[] = [];
    for (const raw of value.split(',')) {
        const candidate = raw.trim();
        if (!candidate) continue;
        try {
            result.push(new URL(candidate).origin);
        } catch {
            // 忽略非法配置项，避免整站因为一个笔误直接不可用
        }
    }
    return result;
}

function hostnameOf(origin: string): string | null {
    try {
        return new URL(origin).hostname;
    } catch {
        return null;
    }
}

export interface OriginCheckContext {
    requestUrl: string;
    frontendUrl?: string | null;
}

/** origin 是否允许作为跨域请求来源。 */
export function isAllowedOrigin(origin: string | undefined, context: OriginCheckContext): boolean {
    if (!origin) return false;

    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }

    const request = (() => {
        try {
            return new URL(context.requestUrl);
        } catch {
            return null;
        }
    })();

    if (request && parsed.origin === request.origin) return true;
    if (request && parsed.hostname === request.hostname) return true;
    if (LOCAL_HOSTNAMES.has(parsed.hostname)) return true;
    if (parseConfiguredOrigins(context.frontendUrl).includes(parsed.origin)) return true;

    return false;
}

/**
 * OAuth 回跳地址等场景：判断一个完整的 URL 是否指向可信前端。
 * 与 isAllowedOrigin 的差别是同时校验主机名而不是只校验 origin。
 */
export function isTrustedFrontendUrl(url: string, context: OriginCheckContext): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }

    return isAllowedOrigin(parsed.origin, context) || LOCAL_HOSTNAMES.has(parsed.hostname);
}

export function hostnameOfOrigin(origin: string): string | null {
    return hostnameOf(origin);
}
