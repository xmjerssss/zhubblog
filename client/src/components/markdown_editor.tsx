import Editor from '@monaco-editor/react';
import { editor, Range, Selection } from 'monaco-editor';
import React, { useRef, useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import { FlatInset, FlatTabButton } from "@rin/ui";
import { useAlert } from "./dialog";
import { useColorMode } from "../utils/darkModeUtils";
import { MAX_UPLOAD_SIZE } from "../api/client";
import { buildMarkdownImage, uploadImageFile } from "../utils/image-upload";
import { Markdown } from "./markdown";
import {
  ColorSwatches,
  HIGHLIGHT_COLORS,
  TEXT_COLORS,
  ToolbarDropdown,
  toolbarButtonClass,
  type ToolbarMenuItem,
} from "./markdown_editor_menus";

interface MarkdownEditorProps {
  content: string;
  setContent: (content: string) => void;
  placeholder?: string;
  height?: string;
}

type EditorPosition = {
  lineNumber: number;
  column: number;
};

const CODE_FENCE = "```";

// 高亮底色一律配深色文字：暗色主题下浅底+深字依然可读。
const HIGHLIGHT_TEXT_COLOR = "#111827";

const CODE_LANGUAGES: { key: string; label: string }[] = [
  { key: "", label: "纯文本" },
  { key: "javascript", label: "JavaScript" },
  { key: "typescript", label: "TypeScript" },
  { key: "jsx", label: "JSX" },
  { key: "tsx", label: "TSX" },
  { key: "json", label: "JSON" },
  { key: "html", label: "HTML" },
  { key: "css", label: "CSS" },
  { key: "scss", label: "SCSS" },
  { key: "bash", label: "Bash / Shell" },
  { key: "powershell", label: "PowerShell" },
  { key: "python", label: "Python" },
  { key: "go", label: "Go" },
  { key: "java", label: "Java" },
  { key: "kotlin", label: "Kotlin" },
  { key: "swift", label: "Swift" },
  { key: "dart", label: "Dart" },
  { key: "c", label: "C" },
  { key: "cpp", label: "C++" },
  { key: "csharp", label: "C#" },
  { key: "rust", label: "Rust" },
  { key: "php", label: "PHP" },
  { key: "ruby", label: "Ruby" },
  { key: "sql", label: "SQL" },
  { key: "yaml", label: "YAML" },
  { key: "toml", label: "TOML" },
  { key: "ini", label: "INI" },
  { key: "docker", label: "Dockerfile" },
  { key: "nginx", label: "Nginx" },
  { key: "graphql", label: "GraphQL" },
  { key: "markdown", label: "Markdown" },
  { key: "diff", label: "Diff" },
  { key: "makefile", label: "Makefile" },
  { key: "lua", label: "Lua" },
  { key: "solidity", label: "Solidity" },
];

const ALERT_TYPES: { key: string; label: string; sample: string }[] = [
  { key: "NOTE", label: "提示 Note", sample: "这里是一个补充说明。" },
  { key: "TIP", label: "技巧 Tip", sample: "这里是一个小技巧。" },
  { key: "IMPORTANT", label: "重要 Important", sample: "这里是要点强调。" },
  { key: "WARNING", label: "警告 Warning", sample: "这里需要注意风险。" },
  { key: "CAUTION", label: "危险 Caution", sample: "这里是有风险的操作用法。" },
];

function positionAfterText(startLineNumber: number, startColumn: number, text: string): EditorPosition {
  const lines = text.split("\n");

  if (lines.length === 1) {
    return {
      lineNumber: startLineNumber,
      column: startColumn + text.length,
    };
  }

  return {
    lineNumber: startLineNumber + lines.length - 1,
    column: lines[lines.length - 1].length + 1,
  };
}

function MarkdownToolButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={toolbarButtonClass}
    >
      <i className={icon} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function buildHtmlVideo(url: string, mime = "video/mp4") {
  const type = !mime || mime === "video/quicktime" ? "video/mp4" : mime;
  return `\n\n<video controls width="100%" preload="metadata" style="border-radius: 12px; margin: 16px 0; background: #000;">\n  <source src="${url}" type="${type}">\n  Your browser does not support the video tag.\n</video>\n\n`;
}

function isVideoFile(file: File) {
  return file.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(file.name);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

function buildFileLink(name: string, url: string) {
  const safeName = name.replace(/[[\]]/g, "");
  return `\n\n[📎 ${safeName}](${url.replace(/\s/g, "%20")})\n\n`;
}

function buildTable(columns = 3, rows = 2) {
  const header = `| ${Array.from({ length: columns }, (_, index) => `列 ${index + 1}`).join(" | ")} |`;
  const divider = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, () => (
    `| ${Array.from({ length: columns }, () => "内容").join(" | ")} |`
  )).join("\n");
  return `\n\n${header}\n${divider}\n${body}\n\n`;
}

// 只清理行内样式标签与成对的强调标记，不会动到正文文字。
function stripInlineStyles(text: string) {
  return text
    .replace(/<\/?(?:span|mark|u|sup|sub|font|b|i|strong|em|del|kbd|small)\b[^>]*>/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

export function MarkdownEditor({ content, setContent, placeholder = "> Write your content here...", height = "400px" }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const colorMode = useColorMode();
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const isComposingRef = useRef(false);
  const [preview, setPreview] = useState<'edit' | 'preview' | 'comparison'>('edit');
  const [uploading, setUploading] = useState(false);
  const { showAlert, AlertUI } = useAlert();

  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoUrlInput, setVideoUrlInput] = useState('');

  // ── 上传插入锚点 ──────────────────────────────────────────────
  // 手机端从相册选完图回到页面时，编辑器选区经常已经丢失（回到 1,1），
  // 之前每次插入都是重新 getSelection()，于是第二张图会插到文章开头，
  // 发布后就成了“先上传的在下、后上传的在上”。这里改用 Monaco 的
  // 跟踪装饰（decoration）记一个随编辑自动漂移的锚点：一次多选共用同一
  // 锚点，插入一张就把锚点挪到刚插入内容的末尾，顺序永远等于上传顺序。
  const anchorCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const anchorOptions = useMemo(() => ({
    stickiness: editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    description: "markdown-editor-insert-anchor",
  }), []);

  const getAnchorCollection = () => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return null;
    if (!anchorCollectionRef.current) {
      anchorCollectionRef.current = editorInstance.createDecorationsCollection([]);
    }
    return anchorCollectionRef.current;
  };

  const setInsertAnchor = (position: EditorPosition) => {
    const collection = getAnchorCollection();
    if (!collection) return;
    collection.set([{
      range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
      options: anchorOptions,
    }]);
  };

  const captureInsertAnchor = () => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel();
    if (!editorInstance || !model) return;

    const selection = editorInstance.getSelection();
    // 手机端从相册返回后选区经常被重置到 (1,1)，与「真的把光标放在文首」无法区分。
    // 正文非空时按「追加到文末」处理，否则多选上传会把图片倒序插到开头。
    const lostAtStart = !selection
      || (selection.isEmpty() && selection.startLineNumber === 1 && selection.startColumn === 1);
    const isEmptyDocument = model.getValue().trim().length === 0;

    const start = (lostAtStart && !isEmptyDocument)
      ? { lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) }
      : selection?.getStartPosition() ?? {
          lineNumber: model.getLineCount(),
          column: model.getLineMaxColumn(model.getLineCount()),
        };
    setInsertAnchor({ lineNumber: start.lineNumber, column: start.column });
  };

  const readInsertAnchor = (): Range | null => {
    const ranges = getAnchorCollection()?.getRanges() ?? [];
    if (ranges.length > 0) {
      return ranges[0];
    }
    const selection = editorRef.current?.getSelection();
    if (!selection) return null;
    return new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn);
  };

  const insertMedia = async (
    file: File,
    showAlertFn: (msg: string) => void,
  ) => {
    try {
      const isVideo = isVideoFile(file);
      const isImage = isImageFile(file);
      const result = await uploadImageFile(file);
      const editorInstance = editorRef.current;
      const model = editorInstance?.getModel();
      if (!editorInstance || !model) return;

      const anchor = readInsertAnchor();
      if (!anchor) return;

      const textToInsert = isVideo
        ? buildHtmlVideo(result.url, file.type)
        : isImage
          ? buildMarkdownImage(file.name, result.url, {
              blurhash: result.blurhash,
              width: result.width,
              height: result.height,
            })
          : buildFileLink(file.name, result.url);

      editorInstance.executeEdits("markdown-upload", [{
        range: anchor,
        text: textToInsert,
        forceMoveMarkers: true,
      }]);
      setContent(editorInstance.getValue());

      const end = positionAfterText(anchor.startLineNumber, anchor.startColumn, textToInsert);
      setInsertAnchor(end);
      const position = new Selection(end.lineNumber, end.column, end.lineNumber, end.column);
      editorInstance.setSelection(position);
      editorInstance.revealPositionInCenterIfOutsideViewport({ lineNumber: end.lineNumber, column: end.column });
    } catch (error) {
      console.error(error);
      showAlertFn(error instanceof Error ? error.message : t("upload.failed"));
    }
  };

  // 串行上传队列：多选、分多次点击、拖拽与粘贴都排队执行，避免并发交叉。
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingUploadsRef = useRef(0);

  const queueUploads = (files: File[]) => {
    if (files.length === 0) return;
    pendingUploadsRef.current += 1;
    setUploading(true);

    uploadQueueRef.current = uploadQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        for (const file of files) {
          await insertMedia(file, showAlert);
        }
      })
      .finally(() => {
        pendingUploadsRef.current = Math.max(0, pendingUploadsRef.current - 1);
        if (pendingUploadsRef.current === 0) {
          setUploading(false);
        }
      });
  };

  const getEditorAndSelection = () => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel();
    const selection = editorInstance?.getSelection();

    if (!editorInstance || !model || !selection) {
      return null;
    }

    return { editorInstance, model, selection };
  };

  const replaceSelection = (range: Range, text: string, nextSelection?: Selection) => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    editorInstance.executeEdits("markdown-toolbar", [{
      range,
      text,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());

    if (nextSelection) {
      editorInstance.setSelection(nextSelection);
    } else {
      const position = positionAfterText(range.startLineNumber, range.startColumn, text);
      editorInstance.setPosition(position);
    }

    editorInstance.focus();
  };

  const wrapSelection = (prefix: string, suffix: string, fallback: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || fallback;
    const insertedText = `${prefix}${innerText}${suffix}`;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  const insertRaw = (text: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;
    replaceSelection(editorState.selection, text);
  };

  const insertLink = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const label = selectedText || t("markdown_editor.placeholder.link_text");
    const url = t("markdown_editor.placeholder.link_url");
    const prefix = `[${label}](`;
    const insertedText = `${prefix}${url})`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const insertMarkdownImage = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const alt = selectedText || t("markdown_editor.placeholder.image_alt");
    const url = t("markdown_editor.placeholder.image_url");
    const prefix = `\n\n![${alt}](`;
    const insertedText = `${prefix}${url})\n\n`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const submitInsertVideo = () => {
    if (!videoUrlInput.trim()) {
      setVideoModalOpen(false);
      return;
    }
    const editorState = getEditorAndSelection();
    if (!editorState) {
      setVideoModalOpen(false);
      return;
    }

    let raw = videoUrlInput.trim();
    let textToInsert = '';

    if (raw.includes("<iframe") && raw.includes("bilibili")) {
      textToInsert = `\n\n<div style="position: relative; padding: 30% 45%; margin: 16px 0;">\n  ${raw.replace(/width=".*?"/, 'width="100%"').replace(/height=".*?"/, 'height="100%" style="position: absolute; width: 100%; height: 100%; left: 0; top: 0; border-radius: 12px;"')}\n</div>\n\n`;
    }
    else if (raw.includes("bilibili.com/video/BV")) {
      const match = raw.match(/BV[a-zA-Z0-9]+/);
      const bvid = match ? match[0] : '';
      textToInsert = `\n\n<div style="position: relative; width: 100%; height: 0; padding-bottom: 56.25%; margin: 16px 0;">\n  <iframe src="//player.bilibili.com/player.html?bvid=${bvid}&page=1&high_quality=1&danmaku=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" style="position: absolute; width: 100%; height: 100%; left: 0; top: 0; border-radius: 12px;"></iframe>\n</div>\n\n`;
    }
    else {
      textToInsert = buildHtmlVideo(raw);
    }

    replaceSelection(editorState.selection, textToInsert);
    setVideoUrlInput('');
    setVideoModalOpen(false);
  };

  const formatSelectedLines = (
    formatter: (line: string, index: number) => string,
    emptyLineFallback: string,
  ) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { editorInstance, model, selection } = editorState;
    const startLineNumber = selection.startLineNumber;
    const endLineNumber = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
    const currentLine = model.getLineContent(startLineNumber);
    const isEmptySingleLine = selection.isEmpty() && currentLine.trim().length === 0;
    const lines = isEmptySingleLine
      ? [emptyLineFallback]
      : Array.from({ length: endLineNumber - startLineNumber + 1 }, (_, index) => {
        const lineNumber = startLineNumber + index;
        return formatter(model.getLineContent(lineNumber), index);
      });
    const targetEndLine = isEmptySingleLine ? startLineNumber : endLineNumber;
    const range = new Range(
      startLineNumber,
      1,
      targetEndLine,
      model.getLineMaxColumn(targetEndLine),
    );
    const insertedText = lines.join("\n");
    const end = positionAfterText(startLineNumber, 1, insertedText);

    editorInstance.executeEdits("markdown-toolbar", [{
      range,
      text: insertedText,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());
    editorInstance.setPosition(end);
    editorInstance.focus();
  };

  const formatHeading = (level: number) => {
    if (level <= 0) {
      formatSelectedLines(
        (line) => line.replace(/^#{1,6}\s+/, ""),
        "",
      );
      return;
    }

    const hashes = "#".repeat(Math.min(level, 6));
    formatSelectedLines(
      (line) => `${hashes} ${line.replace(/^#{1,6}\s+/, "")}`,
      `${hashes} ${t("markdown_editor.placeholder.heading")}`,
    );
  };

  const formatQuote = () => {
    formatSelectedLines(
      (line) => line.startsWith("> ") ? line : `> ${line}`,
      `> ${t("markdown_editor.placeholder.quote")}`,
    );
  };

  const formatUnorderedList = () => {
    formatSelectedLines(
      (line) => line.match(/^\s*[-*]\s/) ? line : `- ${line}`,
      `- ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  const formatOrderedList = () => {
    formatSelectedLines(
      (line, index) => line.match(/^\s*\d+\.\s/) ? line : `${index + 1}. ${line}`,
      `1. ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  const formatTaskList = () => {
    formatSelectedLines(
      (line) => /^\s*[-*]\s+\[[ xX]\]\s+/.test(line) ? line : `- [ ] ${line.replace(/^\s*[-*]\s+/, "")}`,
      "- [ ] 待办事项",
    );
  };

  // 用 <div style="text-align:..."> 包住选中行：rehype-raw 会原样保留，
  // 渲染链不需要任何改动（已经通过 rehypeSafeHtml 的 style 白名单）。
  const wrapSelectedLines = (open: string, close: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const startLine = selection.startLineNumber;
    const endLine = selection.endLineNumber > startLine && selection.endColumn === 1
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
    const lines = Array.from({ length: endLine - startLine + 1 }, (_, index) => model.getLineContent(startLine + index));
    const inner = lines.join("\n").trim() || "内容";
    const text = `${open}\n\n${inner}\n\n${close}`;
    const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));

    replaceSelection(range, text);
  };

  const insertCodeBlock = (language = "", fallbackBody?: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const body = selectedText || fallbackBody || t("markdown_editor.placeholder.code_block");
    const prefix = `${CODE_FENCE}${language}\n`;
    const insertedText = `${prefix}${body}\n${CODE_FENCE}`;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, body);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const innerSelection = new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, selectedText ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column) : innerSelection);
  };

  const applyTextColor = (color: string) => {
    if (!color) {
      const editorState = getEditorAndSelection();
      if (!editorState) return;
      const { model, selection } = editorState;
      const selectedText = model.getValueInRange(selection);
      if (!selectedText) return;
      replaceSelection(selection, stripInlineStyles(selectedText));
      return;
    }

    wrapSelection(`<span style="color: ${color}">`, "</span>", "文字");
  };

  const applyHighlight = (color: string) => {
    if (!color) {
      const editorState = getEditorAndSelection();
      if (!editorState) return;
      const { model, selection } = editorState;
      const selectedText = model.getValueInRange(selection);
      if (!selectedText) return;
      replaceSelection(selection, stripInlineStyles(selectedText));
      return;
    }

    wrapSelection(
      `<mark style="background-color: ${color}; color: ${HIGHLIGHT_TEXT_COLOR}; padding: 0 2px; border-radius: 3px">`,
      "</mark>",
      "高亮文字",
    );
  };

  const applyFontSize = (size: "large" | "small") => {
    const value = size === "large" ? "1.2em" : "0.85em";
    wrapSelection(`<span style="font-size: ${value}">`, "</span>", "文字");
  };

  const insertAlert = (type: string, sample: string) => {
    const editorState = getEditorAndSelection();
    const selectedText = editorState ? editorState.model.getValueInRange(editorState.selection).trim() : "";
    const body = (selectedText || sample)
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
    insertRaw(`\n\n> [!${type}]\n${body}\n\n`);
  };

  const insertDetails = () => {
    const editorState = getEditorAndSelection();
    const selectedText = editorState ? editorState.model.getValueInRange(editorState.selection).trim() : "";
    const inner = selectedText || "这里是被折叠的内容。";
    insertRaw(`\n\n<details>\n<summary>点击展开</summary>\n\n${inner}\n\n</details>\n\n`);
  };

  const alignSelectedBlock = (align: "center" | "right") => {
    wrapSelectedLines(`<div style="text-align: ${align}">`, "</div>");
  };

  const tableItems: ToolbarMenuItem[] = [
    { key: "table3", label: "3 列表格", icon: "ri-table-line", onClick: () => insertRaw(buildTable(3)) },
    { key: "table2", label: "2 列表格", icon: "ri-table-line", onClick: () => insertRaw(buildTable(2)) },
    { key: "table4", label: "4 列表格", icon: "ri-table-line", onClick: () => insertRaw(buildTable(4)) },
  ];

  const headingItems: ToolbarMenuItem[] = [
    { key: "h1", label: "一级标题", hint: "H1", onClick: () => formatHeading(1) },
    { key: "h2", label: "二级标题", hint: "H2", onClick: () => formatHeading(2) },
    { key: "h3", label: "三级标题", hint: "H3", onClick: () => formatHeading(3) },
    { key: "h4", label: "四级标题", hint: "H4", onClick: () => formatHeading(4) },
    { key: "p", label: "正文（去掉标题）", icon: "ri-paragraph", onClick: () => formatHeading(0) },
  ];

  const codeItems: ToolbarMenuItem[] = CODE_LANGUAGES.map((language) => ({
    key: language.key || "plain",
    label: language.label,
    onClick: () => insertCodeBlock(language.key),
  }));

  const mathItems: ToolbarMenuItem[] = [
    { key: "inline-math", label: "行内公式", hint: "$x$", onClick: () => wrapSelection("$", "$", "E = mc^2") },
    { key: "block-math", label: "独立公式块", hint: "$$", onClick: () => insertRaw("\n\n$$\n\\int_0^1 x^2 \\mathrm{d}x = \\frac{1}{3}\n$$\n\n") },
  ];

  const moreItems: ToolbarMenuItem[] = [
    { key: "task-list", label: "任务列表", icon: "ri-checkbox-circle-line", onClick: formatTaskList },
    { key: "inline-code", label: "行内代码", icon: "ri-code-s-slash-line", onClick: () => wrapSelection("`", "`", t("markdown_editor.placeholder.code")) },
    { key: "hr", label: "分割线", icon: "ri-separator", onClick: () => insertRaw("\n\n---\n\n") },
    { key: "details", label: "折叠块", icon: "ri-arrow-down-s-line", onClick: insertDetails },
    { key: "mermaid", label: "Mermaid 流程图", icon: "ri-flow-chart", onClick: () => insertCodeBlock("mermaid", "graph TD\n    A[开始] --> B{判断}\n    B -->|是| C[结束]\n    B -->|否| A") },
    { key: "center", label: "居中对齐", icon: "ri-align-center", onClick: () => alignSelectedBlock("center") },
    { key: "right", label: "右对齐", icon: "ri-align-right", onClick: () => alignSelectedBlock("right") },
    { key: "sup", label: "上标", icon: "ri-superscript", onClick: () => wrapSelection("<sup>", "</sup>", "2") },
    { key: "sub", label: "下标", icon: "ri-subscript", onClick: () => wrapSelection("<sub>", "</sub>", "2") },
    { key: "clear", label: "清除行内格式", icon: "ri-format-clear", onClick: () => {
      const editorState = getEditorAndSelection();
      if (!editorState) return;
      const selectedText = editorState.model.getValueInRange(editorState.selection);
      if (!selectedText) return;
      replaceSelection(editorState.selection, stripInlineStyles(selectedText));
    } },
    { key: "video-link", label: "插入视频链接 / B站", icon: "ri-film-line", onClick: () => setVideoModalOpen(true) },
  ];

  const alertItems: ToolbarMenuItem[] = ALERT_TYPES.map((alert) => ({
    key: alert.key,
    label: alert.label,
    icon: "ri-error-warning-line",
    onClick: () => insertAlert(alert.key, alert.sample),
  }));

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const clipboardData = event.clipboardData;
    if (clipboardData.files.length >= 1) {
      const editorInstance = editorRef.current;
      if (!editorInstance) return;
      captureInsertAnchor();
      queueUploads(Array.from(clipboardData.files));
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    captureInsertAnchor();
    queueUploads(files);
  };

  function UploadMediaButton() {
    const uploadImageRef = useRef<HTMLInputElement>(null);
    const uploadVideoRef = useRef<HTMLInputElement>(null);
    const uploadFileRef = useRef<HTMLInputElement>(null);

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>, kind: "image" | "video" | "file") => {
      const input = event.currentTarget;
      const files = input.files ? Array.from(input.files) : [];
      input.value = "";
      if (files.length === 0) return;

      const maxSize = kind === "image" ? 10 * 1024 * 1024 : MAX_UPLOAD_SIZE;
      const sizeLimitName = kind === "image" ? "10" : String(Math.floor(MAX_UPLOAD_SIZE / 1024 / 1024));

      const accepted = files.filter((file) => {
        if (file.size > maxSize) {
          showAlert(t("upload.failed$size", { size: sizeLimitName }));
          return false;
        }
        return true;
      });
      if (accepted.length === 0) return;

      queueUploads(accepted);
    };

    return (
      <div className="flex items-center gap-1">
        {/* 图片选择器 */}
        <input
          ref={uploadImageRef}
          onChange={(e) => handleUpload(e, "image")}
          className="hidden"
          type="file"
          multiple
          accept="image/*"
        />
        <MarkdownToolButton
          label={t("markdown_editor.toolbar.upload_image")}
          icon="ri-image-add-line"
          disabled={uploading}
          onClick={() => {
            captureInsertAnchor();
            uploadImageRef.current?.click();
          }}
        />

        {/* 视频选择器：精确指定为 video/*，让手机系统直接唤起视频相册并显示封面预览 */}
        <input
          ref={uploadVideoRef}
          onChange={(e) => handleUpload(e, "video")}
          className="hidden"
          type="file"
          accept="video/*"
        />
        <MarkdownToolButton
          label="上传本地视频"
          icon="ri-video-upload-line"
          disabled={uploading}
          onClick={() => {
            captureInsertAnchor();
            uploadVideoRef.current?.click();
          }}
        />

        {/* 通用附件/文件选择器 */}
        <input
          ref={uploadFileRef}
          onChange={(e) => handleUpload(e, "file")}
          className="hidden"
          type="file"
          multiple
        />
        <MarkdownToolButton
          label="上传文件（附件）"
          icon="ri-attachment-2"
          disabled={uploading}
          onClick={() => {
            captureInsertAnchor();
            uploadFileRef.current?.click();
          }}
        />
      </div>
    );
  }

  const handleEditorMount = (editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;

    editorInstance.onDidCompositionStart(() => {
      isComposingRef.current = true;
    });

    editorInstance.onDidCompositionEnd(() => {
      isComposingRef.current = false;
      setContent(editorInstance.getValue());
    });

    editorInstance.onDidChangeModelContent(() => {
      if (!isComposingRef.current) {
        setContent(editorInstance.getValue());
      }
    });

    editorInstance.onDidBlurEditorText(() => {
      setContent(editorInstance.getValue());
    });
  };

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    const model = editorInstance.getModel();
    if (!model) return;

    const editorValue = model.getValue();

    if (editorValue !== content) {
      editorInstance.setValue(content);
      anchorCollectionRef.current?.clear();
    }
  }, [content]);

  const wordCount = useMemo(() => content.replace(/\s/g, "").length, [content]);
  const lineCount = useMemo(() => content.split("\n").length, [content]);

  return (
    <div className="flex flex-col gap-0 sm:gap-3">
      <FlatInset className="flex flex-wrap items-center gap-2 border-0 border-b border-black/10 rounded-none bg-transparent p-2 dark:border-white/10 sm:p-3">
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <FlatTabButton active={preview === 'edit'} onClick={() => setPreview('edit')}> {t("edit")} </FlatTabButton>
          <FlatTabButton active={preview === 'preview'} onClick={() => setPreview('preview')}> {t("preview")} </FlatTabButton>
          <FlatTabButton active={preview === 'comparison'} onClick={() => setPreview('comparison')}> {t("comparison")} </FlatTabButton>
        </div>
        <div className="flex-grow" />
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="toolbar"
          aria-label={t("markdown_editor.toolbar.label")}
        >
          <MarkdownToolButton label="撤销" icon="ri-arrow-go-back-line" onClick={() => editorRef.current?.trigger("markdown-toolbar", "undo", null)} />
          <MarkdownToolButton label="重做" icon="ri-arrow-go-forward-line" onClick={() => editorRef.current?.trigger("markdown-toolbar", "redo", null)} />

          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />

          <ToolbarDropdown label="标题级别" icon="ri-heading" items={headingItems} />
          <MarkdownToolButton label={t("markdown_editor.toolbar.bold")} icon="ri-bold" onClick={() => wrapSelection("**", "**", t("markdown_editor.placeholder.bold"))} />
          <MarkdownToolButton label={t("markdown_editor.toolbar.italic")} icon="ri-italic" onClick={() => wrapSelection("*", "*", t("markdown_editor.placeholder.italic"))} />
          <MarkdownToolButton label="下划线" icon="ri-underline" onClick={() => wrapSelection("<u>", "</u>", "下划线文字")} />
          <MarkdownToolButton label="删除线" icon="ri-strikethrough" onClick={() => wrapSelection("~~", "~~", "删除线文字")} />

          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />

          <ToolbarDropdown
            label="文字颜色"
            icon="ri-font-color"
            panelClassName="w-48"
          >
            <ColorSwatches
              colors={TEXT_COLORS}
              onPick={(value) => applyTextColor(value)}
              noneLabel="默认颜色"
            />
          </ToolbarDropdown>
          <ToolbarDropdown
            label="背景高亮"
            icon="ri-mark-pen-line"
            panelClassName="w-48"
          >
            <ColorSwatches
              colors={HIGHLIGHT_COLORS}
              onPick={(value) => applyHighlight(value)}
              noneLabel="取消高亮"
            />
          </ToolbarDropdown>
          <ToolbarDropdown label="字号" icon="ri-font-size" items={[
            { key: "large", label: "放大字号", icon: "ri-font-size-2", onClick: () => applyFontSize("large") },
            { key: "small", label: "缩小字号", icon: "ri-font-size", onClick: () => applyFontSize("small") },
          ]} />

          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />

          <MarkdownToolButton label={t("markdown_editor.toolbar.quote")} icon="ri-double-quotes-l" onClick={formatQuote} />
          <MarkdownToolButton label={t("markdown_editor.toolbar.unordered_list")} icon="ri-list-unordered" onClick={formatUnorderedList} />
          <MarkdownToolButton label={t("markdown_editor.toolbar.ordered_list")} icon="ri-list-ordered" onClick={formatOrderedList} />
          <ToolbarDropdown label="提示块" icon="ri-error-warning-line" items={alertItems} />

          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />

          <MarkdownToolButton label={t("markdown_editor.toolbar.link")} icon="ri-link" onClick={insertLink} />
          <MarkdownToolButton label={t("markdown_editor.toolbar.image")} icon="ri-image-line" onClick={insertMarkdownImage} />
          <ToolbarDropdown label="代码块（选择语言）" icon="ri-code-box-line" items={codeItems} panelClassName="w-52" />
          <ToolbarDropdown label="公式" icon="ri-function-line" items={mathItems} />
          <ToolbarDropdown label="表格" icon="ri-table-line" items={tableItems} />
          <ToolbarDropdown label="更多功能" icon="ri-more-2-fill" items={moreItems} panelClassName="w-56" />

          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />
          <UploadMediaButton />
        </div>
        {uploading &&
          <div className="flex flex-row items-center space-x-2 px-2">
            <Loading type="spin" color="#FC466B" height={16} width={16} />
            <span className="text-sm text-neutral-500">{t('uploading')}</span>
          </div>
        }
      </FlatInset>
      <div className={`grid grid-cols-1 gap-0 sm:gap-4 ${preview === 'comparison' ? "lg:grid-cols-2" : ""}`}>
        <div className={"flex min-w-0 flex-col " + (preview === 'preview' ? "hidden" : "")}>
          <div
            className={"relative min-h-0 overflow-hidden rounded-none border-0 bg-w"}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onPaste={handlePaste}
          >
            <Editor
              onMount={handleEditorMount}
              height={height}
              defaultLanguage="markdown"
              defaultValue={content}
              theme={colorMode === "dark" ? "vs-dark" : "light"}
              options={{
                wordWrap: "on",
                fontFamily: "Sarasa Mono SC, JetBrains Mono, monospace",
                fontLigatures: false,
                letterSpacing: 0,
                fontSize: 14,
                lineNumbers: "off",
                accessibilitySupport: "off",
                unicodeHighlight: { ambiguousCharacters: false },
                renderWhitespace: "none",
                renderControlCharacters: false,
                smoothScrolling: false,
                dragAndDrop: true,
                pasteAs: { enabled: false },
              }}
            />
          </div>
          <div className="flex items-center justify-end gap-3 px-2 py-1 text-xs text-neutral-400">
            <span>{wordCount} 字</span>
            <span>{lineCount} 行</span>
          </div>
        </div>
        <div
          className={"min-h-0 overflow-y-auto rounded-none border-0 bg-w px-4 py-4 border-t sm:border-none " + (preview === 'edit' ? "hidden" : "")}
          style={{ height: height }}
        >
          <Markdown content={content ? content : placeholder} />
        </div>
      </div>

      {videoModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-w p-5 shadow-2xl border border-black/10 dark:border-white/10">
            <h3 className="text-base font-bold t-primary mb-2 flex items-center gap-2">
              <i className="ri-film-line text-theme" />
              <span>插入视频</span>
            </h3>
            <p className="text-xs text-neutral-500 mb-3">
              支持直接输入 <b>MP4 视频直链</b>，或者粘贴 <b>Bilibili 视频链接 / iframe 嵌入代码</b>。
            </p>
            <input
              type="text"
              autoFocus
              placeholder="https://example.com/video.mp4 或 B站链接"
              value={videoUrlInput}
              onChange={(e) => setVideoUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitInsertVideo()}
              className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm t-primary outline-none focus:border-theme focus:ring-2 focus:ring-theme/20 dark:border-white/10"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setVideoModalOpen(false);
                  setVideoUrlInput('');
                }}
                className="rounded-xl px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitInsertVideo}
                className="rounded-xl bg-theme px-4 py-2 text-sm text-white hover:opacity-90 font-medium"
              >
                确认插入
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertUI />
    </div>
  );
}
