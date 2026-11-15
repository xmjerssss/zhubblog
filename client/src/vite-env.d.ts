/// <reference types="vite/client" />
declare module 'react-helmet';
declare module 'markdown-toc';
interface ImportMetaEnv {
  /** Umami 站点 ID；不填则不加载任何统计脚本 */
  readonly VITE_UMAMI_WEBSITE_ID?: string;
  /** 自建 Umami 时的脚本地址，默认 https://cloud.umami.is/script.js */
  readonly VITE_UMAMI_SCRIPT_SRC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
