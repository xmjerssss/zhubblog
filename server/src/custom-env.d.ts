import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    /** 站点公开访问地址（可选）。未设置时 sitemap/robots 回退到请求来源 origin */
    FRONTEND_URL?: string;
    /** 加密自定义存储密钥用的主密钥（可选）。未设置时使用 JWT_SECRET 派生 */
    STORAGE_SECRET?: string;
    /** 设为 1/true 时输出缓存、RSS 等调试日志（默认关闭） */
    LOG_DEBUG?: string;
    /** 密码 PBKDF2 迭代次数（默认 10000）。调高更安全，但免费计划 CPU 只有 10ms/请求 */
    PASSWORD_HASH_ITERATIONS?: string;
  }
}

export {};
