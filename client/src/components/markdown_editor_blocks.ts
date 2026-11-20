// 排版块模板：把「带颜色的标题 / 卡片 / 表格 / 徽章」生成成可直接渲染的 HTML 片段。
//
// 为什么用内联 style 而不是 class：渲染链（rehype-raw → rehypeSafeHtml）会保留
// style 属性，而 class 需要改全局 CSS，影响面大、暗色适配也要重做。内联样式
// 只作用于这一段内容，作者想改就改，风险最小。
//
// 注意：这些是 HTML 块，块内不再解析 Markdown（CommonMark 规定）。需要块内写
// 多段 Markdown 时请用「提示块」（> [!TIP] 语法），那个是原生 Markdown。

export type AccentPreset = {
  key: string;
  name: string;
  /** 主色：竖线、图标、强调文字 */
  solid: string;
  /** 浅底色：卡片背景、表头 */
  soft: string;
  /** 边框色 */
  line: string;
  /** 深文字色：放在浅底上保证对比度 */
  ink: string;
};

// 每个色都手工配好「主色 / 浅底 / 边框 / 深字」，避免运行时算色导致明暗反差失控。
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "green", name: "绿", solid: "#16a34a", soft: "#f0fdf4", line: "#bbf7d0", ink: "#15803d" },
  { key: "teal", name: "青", solid: "#0d9488", soft: "#f0fdfa", line: "#99f6e4", ink: "#0f766e" },
  { key: "blue", name: "蓝", solid: "#2563eb", soft: "#eff6ff", line: "#bfdbfe", ink: "#1d4ed8" },
  { key: "indigo", name: "靛", solid: "#4f46e5", soft: "#eef2ff", line: "#c7d2fe", ink: "#4338ca" },
  { key: "purple", name: "紫", solid: "#7c3aed", soft: "#f5f3ff", line: "#ddd6fe", ink: "#6d28d9" },
  { key: "pink", name: "粉", solid: "#db2777", soft: "#fdf2f8", line: "#fbcfe8", ink: "#be185d" },
  { key: "orange", name: "橙", solid: "#ea580c", soft: "#fff7ed", line: "#fed7aa", ink: "#c2410c" },
  { key: "amber", name: "金", solid: "#d97706", soft: "#fffbeb", line: "#fde68a", ink: "#b45309" },
  { key: "red", name: "红", solid: "#dc2626", soft: "#fef2f2", line: "#fecaca", ink: "#b91c1c" },
  { key: "gray", name: "石墨", solid: "#4b5563", soft: "#f3f4f6", line: "#e5e7eb", ink: "#374151" },
];

export function findAccent(key: string): AccentPreset {
  return ACCENT_PRESETS.find((item) => item.key === key) ?? ACCENT_PRESETS[0];
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(value)) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }
  return null;
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => clamp255(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mix(base: string, target: string, ratio: number): string {
  const from = parseHex(base);
  const to = parseHex(target);
  if (!from || !to) return base;
  return toHex([
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ]);
}

/**
 * 自定义取色：由主色推导浅底 / 边框 / 深字，保证对比度不会失控。
 * 非法色值回退到默认绿色。
 */
export function accentFromHex(hex: string): AccentPreset {
  const rgb = parseHex(hex);
  if (!rgb) return ACCENT_PRESETS[0];
  const solid = toHex(rgb);
  return {
    key: `custom-${solid.slice(1)}`,
    name: solid,
    solid,
    soft: mix(solid, "#ffffff", 0.92),
    line: mix(solid, "#ffffff", 0.72),
    ink: mix(solid, "#000000", 0.18),
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function oneLine(text: string, fallback: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return escapeHtml(value || fallback);
}

/** 带左侧竖线的小标题：替代默认 h2，用于文章分节（图里那种绿色竖线标题）。 */
export function buildSectionHeading(text: string, accent: AccentPreset): string {
  const title = oneLine(text, "二、这里是小标题");
  return `\n\n<div style="border-left: 4px solid ${accent.solid}; padding: 2px 0 2px 12px; margin: 28px 0 12px;">\n  <div style="font-size: 1.2em; font-weight: 700; line-height: 1.5; color: ${accent.ink};">${title}</div>\n</div>\n\n`;
}

/** 彩色卡片：浅底 + 左边框 + 标题行，块内直接写文字（换行用 <br>）。 */
export function buildCalloutCard(text: string, accent: AccentPreset, icon = "✅"): string {
  const body = text.trim()
    ? escapeHtml(text.trim()).replace(/\n/g, "<br>")
    : "这里放卡片正文，直接改字就行。";
  return `\n\n<div style="background: ${accent.soft}; border: 1px solid ${accent.line}; border-left: 4px solid ${accent.solid}; border-radius: 10px; padding: 14px 16px; margin: 16px 0;">\n  <div style="font-weight: 700; color: ${accent.ink}; margin-bottom: 6px;">${icon} 卡片标题</div>\n  <div style="line-height: 1.75; color: #374151;">${body}</div>\n</div>\n\n`;
}

/** 彩色表头表格：表头用浅底 + 深字，正文细边框（图里那种浅绿表头表格）。 */
export function buildColorTable(accent: AccentPreset, columns = 3, rows = 2): string {
  const safeColumns = Math.max(2, Math.min(6, columns));
  const safeRows = Math.max(1, Math.min(8, rows));
  const head = Array.from({ length: safeColumns }, (_, index) => (
    `      <th style="background: ${accent.soft}; color: ${accent.ink}; border: 1px solid ${accent.line}; padding: 8px 12px; text-align: left; font-weight: 700; white-space: nowrap;">列 ${index + 1}</th>`
  )).join("\n");
  const cell = `style="border: 1px solid #e5e7eb; padding: 8px 12px; vertical-align: top;"`;
  const body = Array.from({ length: safeRows }, (_, rowIndex) => (
    `    <tr>\n${Array.from({ length: safeColumns }, (_, colIndex) => `      <td ${cell}>内容 ${rowIndex + 1}-${colIndex + 1}</td>`).join("\n")}\n    </tr>`
  )).join("\n");
  return `\n\n<table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 0.95em;">\n  <thead>\n    <tr>\n${head}\n    </tr>\n  </thead>\n  <tbody>\n${body}\n  </tbody>\n</table>\n\n`;
}

/** 标签徽章行：一行小胶囊，适合写关键词、适用人群。 */
export function buildBadgeRow(text: string, accent: AccentPreset): string {
  const items = text.trim()
    ? text.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 8)
    : ["标签一", "标签二", "标签三"];
  const badges = items.map((item) => (
    `<span style="display: inline-block; background: ${accent.soft}; color: ${accent.ink}; border: 1px solid ${accent.line}; border-radius: 999px; padding: 3px 10px; margin: 3px 6px 3px 0; font-size: 0.85em;">${escapeHtml(item)}</span>`
  )).join("\n  ");
  return `\n\n<p style="margin: 12px 0; line-height: 2;">\n  ${badges}\n</p>\n\n`;
}

/** 两栏卡片：flex + wrap，手机上自动变成上下两栏。 */
export function buildCardGrid(text: string, accent: AccentPreset): string {
  const first = oneLine(text, "卡片一标题");
  const card = (title: string, body: string, icon: string) => (
    `    <div style="flex: 1 1 220px; min-width: 200px; background: ${accent.soft}; border: 1px solid ${accent.line}; border-radius: 12px; padding: 14px 16px;">\n      <div style="font-weight: 700; color: ${accent.ink}; margin-bottom: 6px;">${icon} ${title}</div>\n      <div style="line-height: 1.7; color: #374151;">${body}</div>\n    </div>`
  );
  return `\n\n<div style="display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0;">\n${card(first, "这里写这一栏的内容。", "①")}\n${card("卡片二标题", "这里写这一栏的内容。", "②")}\n</div>\n\n`;
}

/** 彩色引用：左侧粗竖线 + 浅底，替代默认灰色引用。 */
export function buildColorQuote(text: string, accent: AccentPreset): string {
  const body = text.trim()
    ? escapeHtml(text.trim()).replace(/\n/g, "<br>")
    : "这里是要强调的一段引用。";
  return `\n\n<div style="border-left: 4px solid ${accent.solid}; background: ${accent.soft}; padding: 12px 14px; border-radius: 0 10px 10px 0; margin: 16px 0; color: #374151; line-height: 1.75;">\n  ${body}\n</div>\n\n`;
}

/** 虚线分割：比 --- 更轻的分段线。 */
export function buildDashedDivider(): string {
  return `\n\n<div style="border-top: 1px dashed #d1d5db; margin: 28px 0;"></div>\n\n`;
}

/** 一键骨架：竖线标题 + 卡片 + 表格 + 徽章，改字即可，照着图里的排版走。 */
export function buildLayoutTemplate(accent: AccentPreset): string {
  return [
    buildSectionHeading("二、三分钟上手", accent),
    buildCalloutCard("这里写一句结论，比如「照着下面三步走就行」。", accent, "✅"),
    buildColorTable(accent, 3, 2),
    buildBadgeRow("关键词一，关键词二，关键词三", accent),
    buildSectionHeading("三、怎么选", accent),
    buildCardGrid("方案 A", accent),
    buildDashedDivider(),
  ].join("");
}

/** 可插入的排版块清单，工具栏直接用这份定义生成菜单。 */
export type LayoutBlockKey =
  | "section"
  | "card"
  | "table3"
  | "table4"
  | "badges"
  | "grid"
  | "quote"
  | "divider"
  | "template";

export function buildLayoutBlock(
  key: LayoutBlockKey,
  options: { text?: string; accent: AccentPreset },
): string {
  const text = options.text ?? "";
  const accent = options.accent;
  switch (key) {
    case "section":
      return buildSectionHeading(text, accent);
    case "card":
      return buildCalloutCard(text, accent);
    case "table3":
      return buildColorTable(accent, 3, 2);
    case "table4":
      return buildColorTable(accent, 4, 2);
    case "badges":
      return buildBadgeRow(text, accent);
    case "grid":
      return buildCardGrid(text, accent);
    case "quote":
      return buildColorQuote(text, accent);
    case "divider":
      return buildDashedDivider();
    case "template":
      return buildLayoutTemplate(accent);
    default:
      return "";
  }
}
