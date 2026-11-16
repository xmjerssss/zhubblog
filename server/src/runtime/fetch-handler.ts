import { configureLogging } from "../utils/logger";
import { getApp } from "./app-instance";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;
// 由 Worker 直接处理的元数据路由（sitemap / robots），需在静态资源分支之前路由到 Hono 应用
const APP_META_ROUTE_PATTERN = /^\/(sitemap\.xml|robots\.txt)$/;

// 静态资源白名单：一旦请求命中这些后缀，就按「文件请求」处理，绝不再回退 SPA 入口。
// 之前的实现用 /\.\w+$/ 判断 + 未命中即回退 index.html，会让缺失的 JS chunk 拿到
// 200 + text/html，浏览器报 "Failed to fetch dynamically imported module"，且该
// HTML 会被 Cloudflare 边缘缓存，导致故障长时间不恢复。
const STATIC_ASSET_PATTERN =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|css|map|json|txt|xml|webmanifest|png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|wasm|mp3|mp4|m4a|webm|ogg|pdf|zip|gz|br)$/i;

// Vite 产物统一落在 /assets/ 下且文件名带内容 hash，可安全长缓存。
const HASHED_ASSET_PREFIX = "/assets/";

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isMetaRoute(pathname: string) {
  return APP_META_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return STATIC_ASSET_PATTERN.test(pathname);
}

// 只有「导航级请求」才允许拿到 SPA 入口 HTML；fetch/XHR 拿 HTML 只会把错误藏得更深。
function isNavigationRequest(request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const mode = request.headers.get("sec-fetch-mode");
  if (mode) {
    return mode === "navigate";
  }

  return (request.headers.get("accept") || "").includes("text/html");
}

function cloneWithHeaders(
  response: Response,
  overrides: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(overrides)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFoundResponse() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function withAssetCacheHeaders(response: Response, pathname: string) {
  return cloneWithHeaders(response, {
    // 带 hash 的产物永久缓存，浏览器与边缘都不用再回源校验；其余静态文件短缓存。
    "cache-control": pathname.startsWith(HASHED_ASSET_PREFIX)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600, must-revalidate",
    "x-content-type-options": "nosniff",
  });
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      return asset;
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return cloneWithHeaders(indexResponse, {
        // index.html 必须每次回源校验：它引用的是带 hash 的 chunk，
        // 缓存住旧 HTML 就等于让用户永久停留在已删除的旧 chunk 上。
        "cache-control": "no-cache, must-revalidate",
        "vary": "Accept-Encoding",
        "x-content-type-options": "nosniff",
      });
    }
  } catch {}

  return null;
}

export async function handleFetch(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
): Promise<Response> {
  configureLogging(env);

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env, executionContext);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isMetaRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return withAssetCacheHeaders(asset, pathname);
    }

    // 非 Vite 产物（自定义 feed、动态 .json 等）仍可能由应用路由提供，交给应用再判定一次；
    // 应用的 notFound 是 404 JSON，不会用 HTML 冒充脚本。
    if (!pathname.startsWith(HASHED_ASSET_PREFIX)) {
      const appResponse = await getApp().fetch(request, env, executionContext);
      if (appResponse.status !== 404) {
        return appResponse;
      }
    }

    // 构建产物确实不存在：如实返回 404，不要用 index.html 冒充脚本。
    return notFoundResponse();
  }

  if (!isNavigationRequest(request)) {
    return notFoundResponse();
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    return indexResponse;
  }

  return new Response("Hi", { status: 200 });
}
