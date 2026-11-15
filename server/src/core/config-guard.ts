// 部署配置的“体检”：只在明显不安全时打警告，不阻断请求。
// 目的是避免把示例值（admin123 / your-jwt-secret-key）直接带到线上。

const PLACEHOLDER_SECRETS = new Set([
    'your-jwt-secret-key',
    'yourjwtsecret',
    'secret',
    'changeme',
    'test',
]);

const WEAK_ADMIN_PASSWORDS = new Set(['admin123', 'admin', 'password', '123456']);

let warned = false;

export function warnInsecureDefaults(env: Env): void {
    if (warned) return;
    warned = true;

    const jwtSecret = env.JWT_SECRET?.trim();
    if (!jwtSecret) {
        console.warn('[config] JWT_SECRET 未设置：所有需要登录的接口都会失败。');
    } else if (PLACEHOLDER_SECRETS.has(jwtSecret.toLowerCase()) || jwtSecret.length < 16) {
        console.warn(
            '[config] JWT_SECRET 仍是示例值或过短，任何人都能伪造登录令牌。' +
            '请改成 >=32 位的随机字符串（例如 openssl rand -hex 32）。',
        );
    }

    if (env.ADMIN_PASSWORD && WEAK_ADMIN_PASSWORDS.has(env.ADMIN_PASSWORD.toLowerCase())) {
        console.warn('[config] ADMIN_PASSWORD 使用了弱口令/示例值，请尽快修改。');
    }

    if (!env.FRONTEND_URL) {
        console.warn(
            '[config] 未设置 FRONTEND_URL：OAuth 回跳与 sitemap 会回退到请求来源。' +
            '正式部署建议显式配置站点地址。',
        );
    }
}
