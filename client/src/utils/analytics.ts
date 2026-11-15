// 可选的站点统计（Umami）。
// 这里不再硬编码任何账号：只有部署时设置了 VITE_UMAMI_WEBSITE_ID 才会加载，
// 避免所有 fork 的访客数据都被送到上游作者的统计账号。
export function setupAnalytics(): void {
  const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;
  if (!websiteId) {
    return;
  }

  const scriptSrc = import.meta.env.VITE_UMAMI_SCRIPT_SRC || "https://cloud.umami.is/script.js";
  const script = document.createElement("script");
  script.defer = true;
  script.src = scriptSrc;
  script.dataset.websiteId = websiteId;
  document.head.appendChild(script);
}
