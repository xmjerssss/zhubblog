// 自定义存储的 SecretKey / WebDAV 密码加密存储（AES-GCM）。
// 主密钥优先使用环境变量 STORAGE_SECRET，没有则用 JWT_SECRET 派生，因此无需额外部署配置。
// 注意：更换 JWT_SECRET（且未设置 STORAGE_SECRET）后，已保存的密钥将无法解密，需要在后台重新填写。

const PREFIX = "v1:";

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function deriveKey(env: Env): Promise<CryptoKey> {
    const secret = env.STORAGE_SECRET || env.JWT_SECRET;
    if (!secret) {
        throw new Error("STORAGE_SECRET or JWT_SECRET is not set");
    }
    const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rin-storage:${secret}`));
    return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, plain: string): Promise<string> {
    if (!plain) return "";
    const key = await deriveKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
    return `${PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(env: Env, encrypted: string): Promise<string> {
    if (!encrypted) return "";
    if (!encrypted.startsWith(PREFIX)) {
        throw new Error("Unsupported secret format");
    }
    const [ivPart, dataPart] = encrypted.slice(PREFIX.length).split(":");
    if (!ivPart || !dataPart) {
        throw new Error("Malformed secret");
    }
    try {
        const key = await deriveKey(env);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(ivPart) as unknown as BufferSource },
            key,
            fromBase64(dataPart) as unknown as BufferSource,
        );
        return new TextDecoder().decode(plain);
    } catch {
        throw new Error("无法解密存储密钥（主密钥可能已变更），请在后台重新填写该存储的密钥");
    }
}
