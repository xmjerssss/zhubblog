// 访客相关工具：爬虫识别与 IP 匿名化。

const BOT_UA_PATTERN = /bot|crawler|spider|crawling|preview|facebookexternalhit|slackbot|telegrambot|discordbot|whatsapp|bingpreview|headlesschrome|lighthouse|axios|curl|wget|python-requests/i;

/** 粗略识别爬虫 / 链接预览 / 命令行客户端，这类请求不应计入浏览量。 */
export function isBotRequest(userAgent?: string | null): boolean {
    if (!userAgent) return true;
    return BOT_UA_PATTERN.test(userAgent);
}

/**
 * 访客 IP 的加盐哈希，用于访问明细统计。
 * 用 JWT_SECRET 作为盐，保证同一 IP 在同一实例内可去重，但不能反推原始地址。
 */
export async function hashVisitorIp(ip: string, secret?: string | null): Promise<string> {
    const data = new TextEncoder().encode(`${ip}:${secret ?? 'rin'}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .slice(0, 8)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
