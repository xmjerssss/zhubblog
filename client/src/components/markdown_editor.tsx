import Editor from '@monaco-editor/react';
import { editor, Range, Selection } from 'monaco-editor';
import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import { FlatInset, FlatTabButton } from "@rin/ui";
import { useAlert } from "./dialog";
import { useColorMode } from "../utils/darkModeUtils";
import { MAX_UPLOAD_SIZE } from "../api/client";
import { buildMarkdownImage, uploadImageFile } from "../utils/image-upload";
import { Markdown } from "./markdown";

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
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent text-lg t-secondary transition-colors hover:border-black/10 hover:bg-neutral-100 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white sm:h-10 sm:w-10"
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

  async function insertMedia(
    file: File,
    range: NonNullable<ReturnType<editor.IStandaloneCodeEditor["getSelection"]>>,
    showAlertFn: (msg: string) => void,
  ) {
    try {
      const isVideo = isVideoFile(file);
      const isImage = isImageFile(file);
      const result = await uploadImageFile(file);
      const editorInstance = editorRef.current;
      if (!editorInstance) return;

      const textToInsert = isVideo
        ? buildHtmlVideo(result.url, file.type)
        : isImage
          ? buildMarkdownImage(file.name, result.url, {
              blurhash: result.blurhash,
              width: result.width,
              height: result.height,
            })
          : buildFileLink(file.name, result.url);

      editorInstance.executeEdits(undefined, [{
        range,
        text: textToInsert,
      }]);
      setContent(editorInstance.getValue());

      const position = positionAfterText(range.startLineNumber, range.startColumn, textToInsert);
      editorInstance.setPosition(position);
      editorInstance.setSelection(new Selection(position.lineNumber, position.column, position.lineNumber, position.column));
    } catch (error) {
      console.error(error);
      showAlertFn(error instanceof Error ? error.message : t("upload.failed"));
    }
  }

  const getEditorAndSelection = () => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel();
    const selection = editorInstance?.getSelection();

    if (!editorInstance || !model || !selection) {
      return null;
    }

    return { editorInstance, model, selection };
  };

  const replaceSelection = (selection: Selection, text: string, nextSelection?: Selection) => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    editorInstance.executeEdits("markdown-toolbar", [{
      range: selection,
      text,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());

    if (nextSelection) {
      editorInstance.setSelection(nextSelection);
    } else {
      const position = positionAfterText(selection.startLineNumber, selection.startColumn, text);
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

  const insertCodeBlock = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || t("markdown_editor.placeholder.code_block");
    const prefix = "```\n";
    const insertedText = `${prefix}${innerText}\n\`\`\``;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  const insertHorizontalRule = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    replaceSelection(editorState.selection, "\n\n---\n\n");
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

  const formatHeading = () => {
    formatSelectedLines(
      (line) => line.startsWith("#") ? `## ${line.replace(/^#+\s*/, "")}` : `## ${line}`,
      `## ${t("markdown_editor.placeholder.heading")}`,
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

  const markdownActions = [
    { key: "heading", icon: "ri-heading", label: t("markdown_editor.toolbar.heading"), onClick: formatHeading },
    { key: "bold", icon: "ri-bold", label: t("markdown_editor.toolbar.bold"), onClick: () => wrapSelection("**", "**", t("markdown_editor.placeholder.bold")) },
    { key: "italic", icon: "ri-italic", label: t("markdown_editor.toolbar.italic"), onClick: () => wrapSelection("*", "*", t("markdown_editor.placeholder.italic")) },
    { key: "link", icon: "ri-link", label: t("markdown_editor.toolbar.link"), onClick: insertLink },
    { key: "image", icon: "ri-image-line", label: t("markdown_editor.toolbar.image"), onClick: insertMarkdownImage },
    { key: "video-link", icon: "ri-film-line", label: "插入视频链接 / B站", onClick: () => setVideoModalOpen(true) },
    { key: "quote", icon: "ri-double-quotes-l", label: t("markdown_editor.toolbar.quote"), onClick: formatQuote },
    { key: "unordered-list", icon: "ri-list-unordered", label: t("markdown_editor.toolbar.unordered_list"), onClick: formatUnorderedList },
    { key: "ordered-list", icon: "ri-list-ordered", label: t("markdown_editor.toolbar.ordered_list"), onClick: formatOrderedList },
    { key: "inline-code", icon: "ri-code-s-slash-line", label: t("markdown_editor.toolbar.inline_code"), onClick: () => wrapSelection("`", "`", t("markdown_editor.placeholder.code")) },
    { key: "code-block", icon: "ri-code-box-line", label: t("markdown_editor.toolbar.code_block"), onClick: insertCodeBlock },
    { key: "horizontal-rule", icon: "ri-separator", label: t("markdown_editor.toolbar.horizontal_rule"), onClick: insertHorizontalRule },
  ];

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const clipboardData = event.clipboardData;
    if (clipboardData.files.length >= 1) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.trigger(undefined, "undo", undefined);
      setUploading(true);
      const files = Array.from(clipboardData.files);
      void (async () => {
        try {
          for (const file of files) {
            const current = editor.getSelection();
            if (!current) break;
            await insertMedia(file, current, showAlert);
          }
        } finally {
          setUploading(false);
        }
      })();
    }
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

      const editor = editorRef.current;
      if (!editor) return;

      const accepted = files.filter((file) => {
        if (file.size > maxSize) {
          showAlert(t("upload.failed$size", { size: sizeLimitName }));
          return false;
        }
        return true;
      });
      if (accepted.length === 0) return;

      setUploading(true);
      void (async () => {
        try {
          for (const file of accepted) {
            const current = editorRef.current?.getSelection();
            if (!current) break;
            await insertMedia(file, current, showAlert);
          }
        } finally {
          setUploading(false);
        }
      })();
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
          onClick={() => uploadImageRef.current?.click()}
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
          onClick={() => uploadVideoRef.current?.click()}
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
          onClick={() => uploadFileRef.current?.click()}
        />
      </div>
    );
  }

  const handleEditorMount = (editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    editor.onDidCompositionStart(() => {
      isComposingRef.current = true;
    });

    editor.onDidCompositionEnd(() => {
      isComposingRef.current = false;
      setContent(editor.getValue());
    });

    editor.onDidChangeModelContent(() => {
      if (!isComposingRef.current) {
        setContent(editor.getValue());
      }
    });

    editor.onDidBlurEditorText(() => {
      setContent(editor.getValue());
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const editorValue = model.getValue();

    if (editorValue !== content) {
      editor.setValue(content);
    }
  }, [content]);

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
          {markdownActions.map((action) => (
            <MarkdownToolButton
              key={action.key}
              label={action.label}
              icon={action.icon}
              onClick={action.onClick}
            />
          ))}
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
            onDrop={(e) => {
              e.preventDefault();
              const editor = editorRef.current;
              if (!editor) return;
              const files = Array.from(e.dataTransfer.files);
              if (files.length === 0) return;
              setUploading(true);
              void (async () => {
                try {
                  for (const file of files) {
                    const current = editor.getSelection();
                    if (!current) break;
                    await insertMedia(file, current, showAlert);
                  }
                } finally {
                  setUploading(false);
                }
              })();
            }}
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
