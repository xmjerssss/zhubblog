import React, { useEffect, useRef, useState } from "react";

// 编辑工具栏的按钮外观与弹层组件。
// 单独成文件是为了让 markdown_editor.tsx 保持可读：那边只关心「插什么文本」，
// 这里只关心「菜单怎么弹、颜色怎么选」。

export const toolbarButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent text-lg t-secondary transition-colors hover:border-black/10 hover:bg-neutral-100 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white sm:h-10 sm:w-10";

export const toolbarActiveButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-theme/40 bg-theme/10 text-lg text-theme transition-colors sm:h-10 sm:w-10";

export type ToolbarMenuItem = {
  key: string;
  label: string;
  icon?: string;
  hint?: string;
  onClick: () => void;
};

export type ColorOption = {
  name: string;
  value: string;
};

// 文字颜色：都选了在明暗两种底色下都能看清的中高饱和色。
export const TEXT_COLORS: ColorOption[] = [
  { name: "默认", value: "" },
  { name: "深灰", value: "#4b5563" },
  { name: "红色", value: "#dc2626" },
  { name: "橙色", value: "#ea580c" },
  { name: "琥珀", value: "#b45309" },
  { name: "绿色", value: "#15803d" },
  { name: "青色", value: "#0e7490" },
  { name: "蓝色", value: "#1d4ed8" },
  { name: "紫色", value: "#7c3aed" },
  { name: "品红", value: "#be185d" },
];

// 高亮底色：浅底配深字，暗色模式下也不会变成白底白字。
export const HIGHLIGHT_COLORS: ColorOption[] = [
  { name: "取消高亮", value: "" },
  { name: "鹅黄", value: "#fef08a" },
  { name: "浅绿", value: "#bbf7d0" },
  { name: "浅蓝", value: "#bfdbfe" },
  { name: "浅粉", value: "#fbcfe8" },
  { name: "浅紫", value: "#e9d5ff" },
  { name: "浅灰", value: "#e5e7eb" },
  { name: "浅橙", value: "#fed7aa" },
];

export type DropdownProps = {
  label: string;
  icon: string;
  disabled?: boolean;
  items?: ToolbarMenuItem[];
  children?: React.ReactNode;
  panelClassName?: string;
  align?: "left" | "right";
};

/**
 * 工具栏下拉：按钮保持编辑器选区（onMouseDown 阻止默认行为），
 * 点面板外或按 Esc 关闭。面板用 absolute + z-index，不改变页面布局。
 */
export function ToolbarDropdown({
  label,
  icon,
  disabled = false,
  items,
  children,
  panelClassName = "",
  align = "right",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className={`${open ? toolbarActiveButtonClass : toolbarButtonClass} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <i className={icon} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute top-full z-40 mt-1 min-w-[11rem] overflow-y-auto rounded-xl border border-black/10 bg-w p-1 shadow-xl dark:border-white/10 ${
            align === "right" ? "right-0" : "left-0"
          } ${panelClassName}`}
          style={{ maxHeight: "min(60vh, 20rem)" }}
        >
          {items
            ? items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm t-primary transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {item.icon ? <i className={`${item.icon} text-base`} aria-hidden="true" /> : null}
                  <span className="flex-1 whitespace-nowrap">{item.label}</span>
                  {item.hint ? (
                    <span className="text-xs text-neutral-400">{item.hint}</span>
                  ) : null}
                </button>
              ))
            : children}
        </div>
      )}
    </div>
  );
}

/**
 * 颜色面板：一行一个色块，点「默认 / 取消高亮」清掉样式。
 */
export function ColorSwatches({
  colors,
  onPick,
  noneLabel,
}: {
  colors: ColorOption[];
  onPick: (value: string) => void;
  noneLabel?: string;
}) {
  return (
    <div className="p-1">
      <div className="grid grid-cols-5 gap-1.5">
        {colors.map((color) => {
          const isNone = color.value === "";
          return (
            <button
              key={color.name}
              type="button"
              title={isNone ? (noneLabel || color.name) : color.name}
              aria-label={isNone ? (noneLabel || color.name) : color.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(color.value)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-xs text-neutral-500 transition-transform hover:scale-105 dark:border-white/15"
              style={isNone ? undefined : { backgroundColor: color.value }}
            >
              {isNone ? <i className="ri-forbid-line" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
