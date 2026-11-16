/**
 * Mermaid 按需加载。
 *
 * 之前 feed / writing 页面在模块顶层 `import mermaid from "mermaid"`，
 * 让 1.4MB 的 mermaid 全量代码进入首屏主包（index-*.js 直接被顶到 1.8MB），
 * 首屏 TTI 与 LCP 都被拖慢。这里改成首次真正需要渲染图表时才 import()，
 * 并复用同一个实例，多次渲染不会重复加载。
 */

type MermaidTheme = "default" | "dark";
type MermaidInstance = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidInstance> | null = null;
// 两个主题共用一个实例，记录当前已初始化的主题，避免重复 initialize 造成图表重绘。
const initializedThemes = new Set<MermaidTheme>();

function loadMermaid(): Promise<MermaidInstance> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => (mod.default ?? mod) as MermaidInstance);
  }
  return mermaidPromise;
}

async function renderBlocks(theme: MermaidTheme) {
  const nodes = document.querySelectorAll<HTMLElement>(`pre.mermaid_${theme}`);
  if (nodes.length === 0) {
    return;
  }

  const mermaid = await loadMermaid();
  if (!initializedThemes.has(theme)) {
    mermaid.initialize({ startOnLoad: false, theme });
    initializedThemes.add(theme);
  }

  await mermaid.run({ suppressErrors: true, nodes });
}

/** 渲染当前页面里 mermaid_default 与 mermaid_dark 两种主题的图表块。 */
export async function renderMermaidBlocks(): Promise<void> {
  try {
    await renderBlocks("default");
    await renderBlocks("dark");
  } catch (error) {
    // 图表渲染失败不应影响正文阅读
    console.warn("[mermaid] render failed", error);
  }
}

// 写文章时的实时预览会高频触发，单个宏任务内合并成一次渲染。
let scheduled = false;

export function scheduleMermaidRender(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void renderMermaidBlocks();
  });
}
