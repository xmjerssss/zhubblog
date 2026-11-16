import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { visualizer } from "rollup-plugin-visualizer";

// Markdown 渲染链所属的第三方包（unified / remark / rehype / katex / 高亮 / 清洗）
const MARKDOWN_VENDOR_PATTERN =
  /[\\/]node_modules[\\/](?:unified|bail|trough|extend|is-plain-obj|devlop|remark-[^\\/]+|rehype-[^\\/]+|mdast-util-[^\\/]+|micromark[^\\/]*|katex|hast-[^\\/]+|hast-util-[^\\/]+|unist-[^\\/]+|unist-util-[^\\/]+|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|ccount|character-entities[^\\/]*|decode-named-character-reference|stringify-entities|trim-lines|trim-trailing-lines|collapse-white-space|zwitch|html-void-elements|web-namespaces|longest-streak|markdown-table|style-to-object|inline-style-parser|parse5|entities|dompurify|prismjs|refractor|highlight\.js|lowlight|github-slugger|emoticon|is-decimal|is-alphanumerical|is-hexadecimal|is-whitespace-character|is-word-character|estree-util-[^\\/]+)[\\/]/;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const serverPort = Number(process.env.RIN_SERVER_PORT || "11499");
  const serverTarget = `http://127.0.0.1:${serverPort}`;
  const cacheDir = process.env.RIN_VITE_CACHE_DIR || "../.vite/client";
  // 产物分析默认关闭：visualizer 会显著拖慢 CI 构建，且无头环境下打开浏览器毫无意义。
  const analyzeBundle = process.env.RIN_ANALYZE === "1";

  return {
    cacheDir,
    // Note: Client configuration is fetched from server at runtime
    // No environment variables are injected at build time
    build: {
      outDir: '../dist/client',
      emptyOutDir: true,
      target: 'es2022',
      reportCompressedSize: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // 稳定命名 + 内容 hash：配合服务端 /assets/ 的 immutable 缓存策略。
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            // 框架运行时单独成块，业务代码迭代时不必让用户重新下载 React。
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|wouter)[\\/]/.test(id)) {
              return 'vendor-react'
            }
            if (/[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector|i18next-http-backend)[\\/]/.test(id)) {
              return 'vendor-i18n'
            }
            // Markdown 渲染链（unified / remark / rehype / katex / 高亮）体量大且极少改动，
            // 单独成块后可长期命中浏览器缓存，业务改动只让业务 chunk 失效。
            if (MARKDOWN_VENDOR_PATTERN.test(id)) {
              return 'vendor-markdown'
            }
            // 编辑器只出现在撰写页，独立成块避免和 markdown 渲染链互相牵连。
            if (/[\\/]node_modules[\\/](@uiw|@codemirror|@lezer|codemirror|crelt|w3c-keyname|style-mod|@uiw__)[\\/]/.test(id)) {
              return 'vendor-editor'
            }
          },
        },
      },
    },
    plugins: [
      react(),
      ...(analyzeBundle
        ? [
            visualizer({
              open: false,
              filename: '../dist/stats.json',
              template: 'raw-data',
              emitFile: false,
            }),
          ]
        : []),
    ],
    server: {
      proxy: {
        "/api": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/rss.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/atom.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/rss.json": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/feed.json": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/feed.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
      },
    },
  }
})
