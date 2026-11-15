import { describe, expect, it } from "bun:test";
import rehypeSafeHtml, { type HastNode } from "../rehypeSafeHtml";

function element(
  tagName: string,
  properties: Record<string, unknown> = {},
  children: HastNode[] = [],
): HastNode {
  return { type: "element", tagName, properties, children };
}

function text(value: string): HastNode {
  return { type: "text", value };
}

function sanitize(children: HastNode[]): HastNode {
  const tree: HastNode = { type: "root", children };
  rehypeSafeHtml()(tree);
  return tree;
}

function find(tree: HastNode, tagName: string): HastNode | undefined {
  for (const child of tree.children ?? []) {
    if (child.type === "element" && child.tagName === tagName) return child;
    const nested = find(child, tagName);
    if (nested) return nested;
  }
  return undefined;
}

describe("rehypeSafeHtml", () => {
  it("drops script/style-like execution vectors", () => {
    const tree = sanitize([
      element("script", {}, [text("alert(1)")]),
      element("form", { action: "https://evil" }, [element("input")]),
      element("meta", { httpEquiv: "refresh", content: "0;url=https://evil" }),
      element("p", {}, [text("kept")]),
    ]);

    expect(find(tree, "script")).toBeUndefined();
    expect(find(tree, "form")).toBeUndefined();
    expect(find(tree, "input")).toBeUndefined();
    expect(find(tree, "meta")).toBeUndefined();
    expect(find(tree, "p")).toBeDefined();
  });

  it("strips inline handlers and dangerous urls", () => {
    const link = element("a", {
      href: "javascript:alert(1)",
      onClick: "alert(1)",
    }, [text("click")]);
    const image = element("img", { src: "data:text/html;base64,xxx", onError: "alert(1)" });
    const safeImage = element("img", { src: "data:image/png;base64,AAA" });

    sanitize([link, image, safeImage]);

    expect(link.properties?.href).toBeUndefined();
    expect(link.properties?.onClick).toBeUndefined();
    expect(image.properties?.src).toBeUndefined();
    expect(image.properties?.onError).toBeUndefined();
    expect(safeImage.properties?.src).toBe("data:image/png;base64,AAA");
  });

  it("keeps embeds but removes srcdoc and non-iframe allowlist attributes", () => {
    const iframe = element("iframe", {
      src: "https://www.youtube.com/embed/abc",
      srcDoc: "<script>alert(1)</script>",
      onLoad: "alert(1)",
      allow: "fullscreen",
      formAction: "https://evil",
    });

    sanitize([iframe]);

    expect(iframe.properties?.src).toBe("https://www.youtube.com/embed/abc");
    expect(iframe.properties?.srcDoc).toBeUndefined();
    expect(iframe.properties?.onLoad).toBeUndefined();
    expect(iframe.properties?.formAction).toBeUndefined();
    expect(iframe.properties?.allow).toBe("fullscreen");
  });

  it("keeps class names needed by katex / mermaid / highlight", () => {
    const span = element("span", { className: ["katex", "math"] }, [text("x")]);
    sanitize([span]);

    expect(span.properties?.className).toEqual(["katex", "math"]);
  });
});
