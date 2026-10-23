import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { MAX_UPLOAD_SIZE } from "../api/client";
import { ImageWithFallback } from "./image-with-fallback";
import {
  DEFAULT_IMAGE_MAX_FILE_SIZE,
  uploadImageFile,
} from "../utils/image-upload";

type ImageUploadInputProps = {
  value: string;
  onChange: (value: string) => void;
  onError?: (message: string) => void;
  placeholder?: string;
  disabled?: boolean;
  shape?: "rounded" | "circle";
  maxFileSize?: number;
};

export function ImageUploadInput({
  value,
  onChange,
  onError,
  placeholder,
  disabled = false,
  shape = "rounded",
  maxFileSize = DEFAULT_IMAGE_MAX_FILE_SIZE,
}: ImageUploadInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const shapeClass = shape === "circle" ? "rounded-full" : "rounded-2xl";

  const isVideo = (url: string) => /\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(url);

  const showError = (message: string) => {
    onError?.(message || t("upload.failed"));
  };

  const handleFile = async (file: File) => {
    const isImageOrVideo = file.type.startsWith("image/") || file.type.startsWith("video/");
    if (!isImageOrVideo) {
      showError("仅支持上传图片或视频文件");
      return;
    }

    // 视频放宽文件大小限制（大文件自动直传到存储桶），图片按默认限制
    const actualLimit = file.type.startsWith("video/") ? MAX_UPLOAD_SIZE : maxFileSize;
    if (file.size > actualLimit) {
      showError(t("upload.failed$size", { size: Math.round(actualLimit / 1024 / 1024) }));
      return;
    }

    setUploading(true);
    try {
      const result = await uploadImageFile(file);
      onChange(result.url);
    } catch (error) {
      showError(error instanceof Error ? error.message : t("upload.failed"));
    } finally {
      setUploading(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div
          className={`relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden border border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.04] ${shapeClass}`}
        >
          {value ? (
            isVideo(value) ? (
              <video
                src={value}
                className="h-full w-full object-cover"
                muted
                playsInline
              />
            ) : (
              <ImageWithFallback
                src={value}
                alt={t("upload.image.preview_alt")}
                className="h-full w-full bg-transparent"
              />
            )
          ) : (
            <i className="ri-image-line text-3xl text-neutral-400" aria-hidden="true" />
          )}
          {uploading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <ReactLoading type="spin" color="#ffffff" height={20} width={20} />
            </div>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <input
            type="url"
            value={value}
            disabled={disabled || uploading}
            placeholder={placeholder || "输入图片或视频直链地址..."}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            className="w-full rounded-xl border border-black/10 bg-w px-4 py-3 text-sm t-primary outline-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:ring-2 focus:ring-theme/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20"
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary transition-colors hover:border-black/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:hover:border-white/20"
            >
              <i className="ri-upload-2-line" aria-hidden="true" />
              <span>{uploading ? t("uploading") : t("upload.title")}</span>
            </button>
            <button
              type="button"
              disabled={disabled || uploading || value.length === 0}
              onClick={() => onChange("")}
              className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-secondary transition-colors hover:border-black/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:hover:border-white/20"
            >
              <i className="ri-close-line" aria-hidden="true" />
              <span>{t("upload.image.clear")}</span>
            </button>
          </div>
        </div>
      </div>

      <div
        className={`rounded-2xl border-2 border-dashed px-4 py-5 text-center transition-colors cursor-pointer ${
          dragging
            ? "border-theme bg-theme/5"
            : "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]"
        }`}
        onClick={() => {
          if (!disabled && !uploading) {
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !uploading) {
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled || uploading) {
            return;
          }
          const file = event.dataTransfer.files?.[0];
          if (file) {
            void handleFile(file);
          }
        }}
      >
        <p className="text-sm font-medium t-primary">
          {dragging ? t("upload.image.drop_now") : "拖拽图片或视频文件到此处，或点击上传"}
        </p>
        <p className="mt-1 text-xs t-secondary">支持常用图片及 MP4 / WebM 视频</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/mp4,video/webm,video/quicktime"
        className="hidden"
        disabled={disabled || uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleFile(file);
          }
        }}
      />
    </div>
  );
}
