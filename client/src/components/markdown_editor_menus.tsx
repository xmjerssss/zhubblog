import React, { useEffect, useRef, useState } from "react";

// 编辑工具栏的按钮外观与弹层组件。
// 单独成文件是为了让 markdown_editor.tsx 保持可读：那边只关心「插什么文本」，
// 这里只关心「菜单怎么弹、颜色怎么选」。

export const toolbarButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent text-lg t-secondary transition-colors hover:border-black/10 hover:bg-neutral-100 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white sm:h-10 sm:w-10 touch-manipulation";

export const toolbarActiveButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-theme/40 bg-theme/10 text-lg text-theme transition-colors sm:h-10 sm:w-10 touch-manipulation";

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

// 文字颜色：都选了在明暗两种底色下都能看清的中高饱和色；绿色给了三档深浅。
export const TEXT_COLORS: ColorOption[] = [
  { name: "默认", value: "" },
  { name: "墨黑", value: "#111827" },
  { name: "深灰", value: "#4b5563" },
  { name: "红色", value: "#dc2626" },
  { name: "橙红", value: "#f97316" },
  { name: "橙色", value: "#ea580c" },
  { name: "琥珀", value: "#b45309" },
  { name: "墨绿", value: "#065f46" },
  { name: "绿色", value: "#15803d" },
  { name: "亮绿", value: "#16a34a" },
  { name: "青色", value: "#0e7490" },
  { name: "天蓝", value: "#0284c7" },
  { name: "蓝色", value: "#1d4ed8" },
  { name: "靛青", value: "#4338ca" },
  { name: "紫色", value: "#7c3aed" },
  { name: "品红", value: "#be185d" },
  { name: "粉色", value: "#db2777" },
  { name: "褐色", value: "#92400e" },
];

// 高亮底色：浅底配深字，暗色模式下也不会变成白底白字。
export const HIGHLIGHT_COLORS: ColorOption[] = [
  { name: "取消高亮", value: "" },
  { name: "鹅黄", value: "#fef08a" },
  { name: "浅绿", value: "#bbf7d0" },
  { name: "薄荷", value: "#d1fae5" },
  { name: "浅青", value: "#ccfbf1" },
  { name: "浅蓝", value: "#bfdbfe" },
  { name: "浅靛", value: "#e0e7ff" },
  { name: "浅紫", value: "#e9d5ff" },
  { name: "浅粉", value: "#fbcfe8" },
  { name: "浅橙", value: "#fed7aa" },
  { name: "浅红", value: "#fecaca" },
  { name: "浅灰", value: "#e5e7eb" },
];

// 工具栏按钮防止「触摸点击把焦点从编辑器抢走」：焦点一跑，手机键盘收起、
// 选区塌陷，插入位置就乱了。只拦鼠标（桌面），触屏上不拦——
// iOS 部分版本里 pointerdown/touchstart 被取消会让 click 不派发，
// 表现恰好就是「点了闪一下、什么也没发生」。
function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function preventFocusSteal(event: React.SyntheticEvent): void {
  if (isCoarsePointer()) return;
  event.preventDefault();
}

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
  // 手机上有时候一次轻触会派发两次 click，面板会开了立刻被关掉（看着像「闪一下」）。
  // 300ms 内只认第一次切换。
  const lastToggleRef = useRef(0);

  const toggle = () => {
    const now = Date.now();
    if (now - lastToggleRef.current < 320) return;
    lastToggleRef.current = now;
    setOpen((value) => !value);
  };

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
        onMouseDown={preventFocusSteal}
        onPointerDown={preventFocusSteal}
        onClick={toggle}
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
                  onMouseDown={preventFocusSteal}
                  onPointerDown={preventFocusSteal}
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
 * allowCustom 打开后多一个原生取色器（手机上直接调系统调色盘）。
 */
export function ColorSwatches({
  colors,
  onPick,
  noneLabel,
  allowCustom = false,
  customLabel = "自定义颜色",
  activeValue,
}: {
  colors: ColorOption[];
  onPick: (value: string) => void;
  noneLabel?: string;
  allowCustom?: boolean;
  customLabel?: string;
  activeValue?: string;
}) {
  return (
    <div className="p-1">
      <div className="grid grid-cols-5 gap-1.5">
        {colors.map((color) => {
          const isNone = color.value === "";
          const isActive = activeValue !== undefined && color.value === activeValue;
          return (
            <button
              key={color.name}
              type="button"
              title={isNone ? (noneLabel || color.name) : color.name}
              aria-label={isNone ? (noneLabel || color.name) : color.name}
              onMouseDown={preventFocusSteal}
              onPointerDown={preventFocusSteal}
              onClick={() => onPick(color.value)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border text-xs text-neutral-500 transition-transform hover:scale-105 ${
                isActive ? "border-2 border-theme" : "border-black/10 dark:border-white/15"
              }`}
              style={isNone ? undefined : { backgroundColor: color.value }}
            >
              {isNone ? <i className="ri-forbid-line" aria-hidden="true" /> : null}
            </button>
          );
        })}
        {allowCustom ? (
          <label
            title={customLabel}
            className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/25 text-xs text-neutral-500 dark:border-white/25"
          >
            <i className="ri-palette-line" aria-hidden="true" />
            <input
              type="color"
              aria-label={customLabel}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              onChange={(event) => onPick(event.target.value)}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 强调色面板：给「竖线小标题 / 卡片 / 彩色表格」选主色。
 * 色块直接取预设的主色，选中项加描边，方便一眼看出当前用的是哪个。
 */
export function AccentSwatches({
  presets,
  activeKey,
  onPick,
  customValue,
}: {
  presets: { key: string; name: string; solid: string }[];
  activeKey: string;
  onPick: (key: string) => void;
  customValue?: string;
}) {
  return (
    <div className="p-1">
      <div className="grid grid-cols-5 gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            title={preset.name}
            aria-label={preset.name}
            onMouseDown={preventFocusSteal}
            onPointerDown={preventFocusSteal}
            onClick={() => onPick(preset.key)}
            className={`h-8 w-8 rounded-lg border transition-transform hover:scale-105 ${
              activeKey === preset.key ? "border-2 border-theme" : "border-black/10 dark:border-white/15"
            }`}
            style={{ backgroundColor: preset.solid }}
          />
        ))}
        <label
          title="自定义强调色"
          className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/25 text-xs text-neutral-500 dark:border-white/25"
        >
          <i className="ri-palette-line" aria-hidden="true" />
          <input
            type="color"
            aria-label="自定义强调色"
            value={customValue || "#16a34a"}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            onChange={(event) => onPick(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
