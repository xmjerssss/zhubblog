export function stripImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return undefined;
    }

    return url.split("#", 2)[0];
}

export function parseImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return {
            src: undefined,
            blurhash: undefined,
            width: undefined,
            height: undefined,
        };
    }

    const [src, fragment = ""] = url.split("#", 2);
    const params = new URLSearchParams(fragment);
    const width = params.get("width");
    const height = params.get("height");

    return {
        src,
        blurhash: params.get("blurhash") || undefined,
        width: width ? Number.parseInt(width, 10) : undefined,
        height: height ? Number.parseInt(height, 10) : undefined,
    };
}

export function listMarkdownImageUrls(content: string) {
    const imagePattern = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/g;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listHtmlImageUrls(content: string) {
    const imagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listContentImageUrls(content: string) {
    return [...listMarkdownImageUrls(content), ...listHtmlImageUrls(content)];
}

export function contentHasImagesMissingMetadata(content: string) {
    return listContentImageUrls(content).some((url) => {
        const metadata = parseImageMetadataFromUrl(url);
        return !metadata.blurhash || !metadata.width || !metadata.height;
    });
}

export function extractImage(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return stripImageMetadataFromUrl(url);
    }
    return undefined;
}

export function extractImageWithMetadata(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return url;
    }
    return undefined;
}

// 站内文件统一由 /api/blob/<key> 提供：文章里存的可能是历史域名（换域名后就是死链），
// 对外输出（RSS / 分享）时统一改写为当前站点地址。
const BLOB_PATH_PATTERN = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+(\/api\/blob\/.*)$/i;
// 新上传的图片入库只存相对路径 /api/blob/<key>，对外输出（RSS / JSON Feed）需要补全域名，
// 否则 feed 库在生成 <enclosure url> 时做 URL 校验会抛 Invalid URL string。
const RELATIVE_BLOB_PATTERN = /^(\/api\/blob\/.*)$/i;

export function normalizeBlobUrl(url?: string | null, origin?: string | null) {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    const base = (origin || "").replace(/\/+$/, "");
    const matched = trimmed.match(BLOB_PATH_PATTERN) ?? trimmed.match(RELATIVE_BLOB_PATTERN);
    if (!matched) return trimmed;
    return base ? `${base}${matched[1]}` : matched[1];
}

// feed 库对 enclosure url 做绝对 URL 校验，单条数据的图片地址异常不应让整个 feed 生成失败（500）。
export function normalizeFeedImageUrl(url?: string | null, origin?: string | null) {
    const normalized = normalizeBlobUrl(url, origin);
    if (!normalized) return undefined;
    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        return normalized;
    } catch {
        return undefined;
    }
}

export function absolutizeBlobUrls(html: string, origin?: string | null) {
    const base = (origin || "").replace(/\/+$/, "");
    if (!html || !base) return html;
    return html
        .replace(/(?:https?:)?\/\/[^\s"')<>]+?(\/api\/blob\/)/gi, `${base}$1`)
        .replace(/(=["'])(\/api\/blob\/)/gi, `$1${base}$2`);
}
