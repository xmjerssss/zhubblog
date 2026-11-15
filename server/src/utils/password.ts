// 密码哈希工具：PBKDF2-SHA256（随机盐 + 可调迭代次数），并兼容历史上的单轮 SHA-256 哈希。
//
// 存储格式：
//   pbkdf2$<iterations>$<salt-base64>$<derived-key-base64>
// 历史格式（旧版本写入 users.password 的值）：
//   <sha256 hex(64 位)>

/**
 * 默认迭代次数。
 *
 * Cloudflare Workers 免费计划每个请求只有 10ms CPU 预算，而 PBKDF2 是纯 CPU 计算：
 * 150k 迭代实测就要 30ms 以上，登录请求会直接以 `error code: 1102`（超出 CPU 时间）
 * 失败——表现就是「密码是对的，但登录不上」。所以默认值取一个在免费计划里也能
 * 正常完成登录的量级，需要更强时可以调 `PASSWORD_HASH_ITERATIONS`（付费计划放宽）。
 */
export const DEFAULT_ITERATIONS = 10_000;
/** 超过这个量级就有很高的撞 CPU 限额风险，仅用于告警提示 */
export const SAFE_ITERATIONS_CEILING = 50_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'pbkdf2';

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** 常量时间比较，避免按字节短路导致的计时侧信道。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** 比较两个字符串（先各自哈希，规避长度差异带来的信息泄露）。 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
    const [ha, hb] = await Promise.all([digest(a), digest(b)]);
    return timingSafeEqual(ha, hb);
}

async function digest(value: string): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return new Uint8Array(hash);
}

async function derive(
    password: string,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );

    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
        baseKey,
        KEY_BYTES * 8,
    );

    return new Uint8Array(bits);
}

/** 读取环境变量里的迭代次数配置，非法值回落到默认值。 */
export function resolveIterations(env?: { PASSWORD_HASH_ITERATIONS?: string } | null): number {
    const raw = env?.PASSWORD_HASH_ITERATIONS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_ITERATIONS;
    }

    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return DEFAULT_ITERATIONS;
    }
    // 上界只是防御性限制，避免误配成天文数字后完全无法登录
    return Math.min(parsed, 1_000_000);
}

/** 从哈希串里读出迭代次数；格式不对时返回 0。 */
export function iterationsOf(stored: string | null | undefined): number {
    if (!stored || !stored.startsWith(`${PREFIX}$`)) return 0;
    const parts = stored.split('$');
    if (parts.length !== 4) return 0;
    const iterations = Number.parseInt(parts[1], 10);
    return Number.isFinite(iterations) ? iterations : 0;
}

/** 生成新的密码哈希（每次调用都会使用新的随机盐）。 */
export async function hashPassword(
    password: string,
    iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const derived = await derive(password, salt, iterations);
    return `${PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * 判断存储的哈希是否需要按当前配置重算：旧格式（单轮 SHA-256）或迭代次数与
 * 目标值不一致都要重算（升配、降配都能自动收敛到当前配置）。
 */
export function needsRehash(
    stored: string | null | undefined,
    targetIterations: number = DEFAULT_ITERATIONS,
): boolean {
    if (!stored) return false;
    if (!stored.startsWith(`${PREFIX}$`)) return true;
    return iterationsOf(stored) !== targetIterations;
}

/** 校验密码，同时支持 PBKDF2 与历史 SHA-256 格式。 */
export async function verifyPassword(
    password: string,
    stored: string | null | undefined,
): Promise<boolean> {
    if (!stored) return false;

    if (!stored.startsWith(`${PREFIX}$`)) {
        // 历史格式：sha256(password) 的十六进制字符串
        const legacy = (await digest(password)).reduce(
            (hex, byte) => hex + byte.toString(16).padStart(2, '0'),
            '',
        );
        return timingSafeEqualString(legacy, stored.toLowerCase());
    }

    const parts = stored.split('$');
    if (parts.length !== 4) return false;

    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;

    let salt: Uint8Array;
    let expected: Uint8Array;
    try {
        salt = fromBase64(parts[2]);
        expected = fromBase64(parts[3]);
    } catch {
        return false;
    }

    const derived = await derive(password, salt, iterations);
    return timingSafeEqual(derived, expected);
}
