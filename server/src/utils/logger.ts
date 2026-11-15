// 统一日志出口：调试信息默认关闭（线上只在 LOG_DEBUG=1 时输出），
// 避免缓存命中、RSS 生成这类高频日志把 Worker 日志刷满。
type Level = "debug" | "info" | "warn" | "error";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

let debugEnabled = false;

/** 在请求入口/定时任务里调用一次，读取 LOG_DEBUG 开关 */
export function configureLogging(env: { LOG_DEBUG?: string } | undefined | null): void {
    const raw = String(env?.LOG_DEBUG ?? "").trim().toLowerCase();
    debugEnabled = ENABLED_VALUES.has(raw);
}

export function isDebugLoggingEnabled(): boolean {
    return debugEnabled;
}

function write(level: Level, scope: string, args: unknown[]): void {
    const prefix = `[${scope}]`;
    switch (level) {
        case "debug":
            console.debug(prefix, ...args);
            return;
        case "info":
            console.info(prefix, ...args);
            return;
        case "warn":
            console.warn(prefix, ...args);
            return;
        default:
            console.error(prefix, ...args);
    }
}

/** 调试日志：默认静默 */
export function debugLog(scope: string, ...args: unknown[]): void {
    if (!debugEnabled) return;
    write("debug", scope, args);
}

/** 正常运行业务日志 */
export function logInfo(scope: string, ...args: unknown[]): void {
    write("info", scope, args);
}

export function logWarn(scope: string, ...args: unknown[]): void {
    write("warn", scope, args);
}

export function logError(scope: string, ...args: unknown[]): void {
    write("error", scope, args);
}
