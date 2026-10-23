import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    /** 站点公开访问地址（可选）。未设置时 sitemap/robots 回退到请求来源 origin */
    FRONTEND_URL?: string;
    /** 加密自定义存储密钥用的主密钥（可选）。未设置时使用 JWT_SECRET 派生 */
    STORAGE_SECRET?: string;
  }
}

export {};
