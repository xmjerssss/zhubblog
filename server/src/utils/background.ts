import type { AppContext } from "../core/hono-types";

/**
 * 把不影响响应的副作用（例如访问明细写入）放到响应之后执行。
 * 在 Worker 里用 waitUntil；在没有执行上下文的环境（单元测试）里退化为直接 await。
 */
export async function runInBackground(
    c: AppContext,
    task: () => Promise<unknown>,
): Promise<void> {
    try {
        // 响应之后执行，失败不能影响用户请求，但要留下日志
        c.executionCtx.waitUntil(
            task().catch((error) => {
                console.error("Background task failed", error);
            }),
        );
        return;
    } catch {
        try {
            await task();
        } catch (error) {
            console.error("Background task failed", error);
        }
    }
}
