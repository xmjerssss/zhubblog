// 安全清洗插件：在 rehype-raw 之后运行，移除可以执行脚本的 HTML 节点与属性。
//
// 为什么不用 rehype-sanitize：项目需要保留 katex / mermaid / 代码高亮的 className
// 以及作者常用的 <video>、<iframe> 嵌入，默认白名单会把这些全部剥掉。这里采用
// “只移除危险项”的策略，既能挡住 XSS，又不会破坏现有 Markdown 的渲染效果。

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

// 这些标签要么能执行脚本，要么会劫持页面（meta refresh / base 改写相对链接）。
const DROPPED_TAGS = new Set([
  'script',
  'base',
  'meta',
  'link',
  'object',
  'embed',
  'applet',
  'frame',
  'frameset',
  'form',
  'input',
  'textarea',
  'select',
  'button',
]);

const DROPPED_ATTRIBUTES = new Set([
  'srcDoc',
  'srcDoc',
  'formAction',
  'httpEquiv',
  'http-equiv',
]);

const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formAction',
  'poster',
  'data',
  'xlinkHref',
  'background',
]);

const IFRAME_ALLOWED_ATTRIBUTES = new Set([
  'src',
  'width',
  'height',
  'allow',
  'allowFullScreen',
  'frameBorder',
  'scrolling',
  'title',
  'loading',
  'referrerPolicy',
  'sandbox',
  'className',
  'class',
  'style',
  'name',
  'id',
]);

function normalizeUrl(value: string): string {
  return value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

function isUnsafeUrl(value: string, attribute: string): boolean {
  const normalized = normalizeUrl(value);
  if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
    return true;
  }
  if (normalized.startsWith('data:text/html') || normalized.startsWith('data:image/svg')) {
    return true;
  }
  // 图片场景允许 data:image/*，其它场景一律收紧
  if (normalized.startsWith('data:') && attribute !== 'src') {
    return true;
  }
  return false;
}

function sanitizeProperties(node: HastNode): void {
  const properties = node.properties;
  if (!properties) return;

  const isIframe = node.tagName === 'iframe';

  for (const key of Object.keys(properties)) {
    // 内联事件处理器
    if (/^on/i.test(key)) {
      delete properties[key];
      continue;
    }

    if (DROPPED_ATTRIBUTES.has(key)) {
      delete properties[key];
      continue;
    }

    if (isIframe && !IFRAME_ALLOWED_ATTRIBUTES.has(key)) {
      delete properties[key];
      continue;
    }

    const value = properties[key];
    if (typeof value === 'string' && URL_ATTRIBUTES.has(key) && isUnsafeUrl(value, key)) {
      delete properties[key];
    }
  }
}

// GFM 任务列表（- [ ] / - [x]）由 remark-gfm 生成只读 checkbox。
// input 整体在黑名单里会被一并剥掉，导致任务列表只剩文字；这里只放行
// type=checkbox 的只读勾选框，其余 input 仍然丢弃。
function isTaskListCheckbox(node: HastNode): boolean {
  if (node.tagName?.toLowerCase() !== 'input') return false;
  const type = node.properties?.type;
  return typeof type === 'string' && type.toLowerCase() === 'checkbox';
}

function walk(node: HastNode): void {
  if (!node.children || node.children.length === 0) return;

  const next: HastNode[] = [];

  for (const child of node.children) {
    if (child.type === 'element' && child.tagName && DROPPED_TAGS.has(child.tagName.toLowerCase()) && !isTaskListCheckbox(child)) {
      continue;
    }

    if (child.type === 'element') {
      sanitizeProperties(child);
    }

    walk(child);
    next.push(child);
  }

  node.children = next;
}

export default function rehypeSafeHtml() {
  return (tree: HastNode) => {
    walk(tree);
    return tree;
  };
}
