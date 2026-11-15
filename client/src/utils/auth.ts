// 登录态完全由服务端下发的 HttpOnly cookie 承载，前端不再保存任何 token。
// 这里只负责清理旧版本遗留在 localStorage 里的 `rin_auth_token`。

const LEGACY_TOKEN_KEY = 'rin_auth_token';

export function clearLegacyAuthToken(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(LEGACY_TOKEN_KEY);
        }
    } catch {
        // 隐私模式下 localStorage 可能不可用，忽略即可
    }
}
