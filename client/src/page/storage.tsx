import type { StorageInput, StorageItem, StorageType } from "@rin/api";
import { Modal, SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, Spinner } from "@rin/ui";
import { useCallback, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import type { StorageListResponse } from "../api/client";
import { client } from "../app/runtime";
import { Button } from "../components/button";
import { useAlert, useConfirm } from "../components/dialog";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";

const GB = 1024 * 1024 * 1024;

type FormState = {
  id?: number;
  type: StorageType;
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secret: string;
  forcePathStyle: boolean;
  folder: string;
  publicUrl: string;
  redirect: boolean;
  priority: string;
  quotaGb: string;
  enabled: boolean;
  hasSecret: boolean;
};

const emptyForm = (type: StorageType = "r2"): FormState => ({
  type,
  name: "",
  endpoint: "",
  bucket: "",
  region: "auto",
  accessKey: "",
  secret: "",
  forcePathStyle: true,
  folder: "",
  publicUrl: "",
  redirect: false,
  priority: "0",
  quotaGb: "",
  enabled: true,
  hasSecret: false,
});

function formFromItem(item: StorageItem): FormState {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    endpoint: item.endpoint,
    bucket: item.bucket,
    region: item.region,
    accessKey: item.accessKey,
    secret: "",
    forcePathStyle: item.forcePathStyle,
    folder: item.folder,
    publicUrl: item.publicUrl,
    redirect: item.redirect,
    priority: String(item.priority),
    quotaGb: item.quotaBytes > 0 ? String(Number((item.quotaBytes / GB).toFixed(2))) : "",
    enabled: item.enabled,
    hasSecret: item.hasSecret,
  };
}

function formToInput(form: FormState): StorageInput {
  const quota = Number.parseFloat(form.quotaGb);
  return {
    id: form.id,
    type: form.type,
    name: form.name,
    endpoint: form.endpoint,
    bucket: form.bucket,
    region: form.region,
    accessKey: form.accessKey,
    secret: form.secret || undefined,
    forcePathStyle: form.forcePathStyle,
    folder: form.folder,
    publicUrl: form.publicUrl,
    redirect: form.redirect,
    priority: Number.parseInt(form.priority, 10) || 0,
    quotaBytes: Number.isFinite(quota) && quota > 0 ? Math.round(quota * GB) : 0,
    enabled: form.enabled,
  };
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

const inputClass =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2 t-primary transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:outline-none focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium t-primary">{label}</span>
      {children}
      {hint ? <span className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</span> : null}
    </label>
  );
}

function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium t-primary">{label}</span>
        {hint ? <span className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</span> : null}
      </span>
    </label>
  );
}

export function StoragePage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const load = useCallback(() => client.storages.list(), []);
  const { data, loading, error, reload } = useApiResource<StorageListResponse>(load);
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [formMessage, setFormMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const items = data?.items ?? [];
  const defaultStorage = data?.defaultStorage;
  const patch = (next: Partial<FormState>) => setForm((current) => (current ? { ...current, ...next } : current));

  const typeLabel = (type: StorageType) =>
    type === "r2"
      ? t("storage.type.r2", "Cloudflare R2")
      : type === "s3"
        ? t("storage.type.s3", "S3 兼容")
        : t("storage.type.webdav", "WebDAV");

  const openCreate = () => {
    setFormMessage(null);
    setForm(emptyForm());
  };

  const selectType = (type: StorageType) => {
    if (!form) return;
    patch({
      type,
      region: type === "r2" ? "auto" : type === "s3" && form.region === "auto" ? "us-east-1" : form.region,
      forcePathStyle: type !== "s3" ? true : form.forcePathStyle,
    });
  };

  const runFormTest = async () => {
    if (!form) return;
    setTesting(true);
    setFormMessage(null);
    const { data: result, error: requestError } = await client.storages.testConfig(formToInput(form));
    setTesting(false);
    if (requestError) {
      setFormMessage({ ok: false, text: requestError.value });
    } else if (result?.ok) {
      setFormMessage({ ok: true, text: t("storage.test_ok", "连接成功：已完成写入、读取、删除测试") });
    } else {
      setFormMessage({ ok: false, text: result?.error || t("storage.test_failed", "连接失败") });
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setFormMessage(null);
    const input = formToInput(form);
    const response = form.id ? await client.storages.update(form.id, input) : await client.storages.create(input);
    setSaving(false);
    if (response.error) {
      setFormMessage({ ok: false, text: response.error.value });
      return;
    }
    setForm(null);
    await reload();
  };

  const toggleEnabled = async (item: StorageItem) => {
    const { error: requestError } = await client.storages.update(item.id, { enabled: !item.enabled });
    if (requestError) showAlert(requestError.value);
    await reload();
  };

  const resetStatus = async (item: StorageItem) => {
    const { error: requestError } = await client.storages.update(item.id, { status: "ok" });
    if (requestError) showAlert(requestError.value);
    await reload();
  };

  const testItem = async (item: StorageItem) => {
    setTestingId(item.id);
    const { data: result, error: requestError } = await client.storages.test(item.id);
    setTestingId(null);
    if (requestError) {
      showAlert(requestError.value);
    } else if (result?.ok) {
      showAlert(t("storage.test_ok", "连接成功：已完成写入、读取、删除测试"));
    } else {
      showAlert(result?.error || t("storage.test_failed", "连接失败"));
    }
    await reload();
  };

  const testDefault = async () => {
    setTestingId(0);
    const { data: result, error: requestError } = await client.storages.testDefault();
    setTestingId(null);
    if (requestError) showAlert(requestError.value);
    else if (result?.ok) showAlert(t("storage.test_ok", "连接成功：已完成写入、读取、删除测试"));
    else showAlert(result?.error || t("storage.test_failed", "连接失败"));
  };

  const removeItem = (item: StorageItem) => {
    const hasFiles = item.fileCount > 0;
    showConfirm(
      t("storage.delete_title", "删除存储"),
      hasFiles
        ? t(
            "storage.delete_with_files",
            "「{{name}}」里有 {{count}} 个文件正在被文章使用，删除后这些图片/视频/文件将无法访问。建议改为“停用”。确定仍要删除吗？",
            { name: item.name, count: item.fileCount },
          )
        : t("storage.delete_empty", "确定删除「{{name}}」吗？", { name: item.name }),
      async () => {
        const { error: requestError } = await client.storages.remove(item.id, hasFiles);
        if (requestError) showAlert(requestError.value);
        await reload();
      },
    );
  };

  const statusBadge = (item: StorageItem) => {
    if (!item.enabled) return <SettingsBadge>{t("storage.status.disabled", "已停用")}</SettingsBadge>;
    if (item.status === "full") return <SettingsBadge tone="warning">{t("storage.status.full", "已满")}</SettingsBadge>;
    if (item.status === "error") return <SettingsBadge tone="warning">{t("storage.status.error", "异常")}</SettingsBadge>;
    return <SettingsBadge tone="success">{t("storage.status.ok", "使用中")}</SettingsBadge>;
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("storage.title", "存储管理")} - ${siteConfig.name}`}</title>
      </Helmet>
      <AlertUI />
      <ConfirmUI />

      <SettingsCard>
        <SettingsCardHeader
          title={t("storage.how_title", "上传规则")}
          description={t(
            "storage.how_desc",
            "上传图片、视频和文件时，优先保存到下面按“优先级”从高到低排列、且可用的自定义存储；某个存储失败或已满会自动换下一个；没有可用的自定义存储时，才保存到部署时通过环境变量绑定的默认存储。文章里只保存 /api/blob/… 链接，更换或停用存储后，旧文件依然可以正常显示。",
          )}
        />
      </SettingsCard>

      <SettingsCard tone={defaultStorage?.configured ? "success" : "warning"}>
        <SettingsCardHeader
          title={t("storage.default_title", "默认存储（环境变量）")}
          description={
            defaultStorage?.configured
              ? defaultStorage.type === "r2-binding"
                ? t("storage.default_r2", "已绑定 Cloudflare R2（R2_BUCKET）。作为兜底存储，始终保留。")
                : t("storage.default_s3", "已配置 S3_* 环境变量。作为兜底存储，始终保留。")
              : t("storage.default_none", "未配置默认存储。请至少添加一个自定义存储，否则无法上传。")
          }
          badge={
            <SettingsBadge tone={defaultStorage?.configured ? "success" : "warning"}>
              {defaultStorage?.configured ? t("storage.status.ok", "使用中") : t("storage.status.none", "未配置")}
            </SettingsBadge>
          }
        />
        {defaultStorage?.configured ? (
          <SettingsCardBody>
            <Button
              secondary
              title={testingId === 0 ? t("storage.testing", "测试中…") : t("storage.test", "测试连接")}
              disabled={testingId !== null}
              onClick={testDefault}
            />
          </SettingsCardBody>
        ) : null}
      </SettingsCard>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold t-primary">{t("storage.custom_title", "自定义存储")}</h2>
        <Button title={t("storage.add", "添加存储")} onClick={openCreate} />
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-3 py-6 text-sm text-neutral-500 dark:text-neutral-400">
          <Spinner label={t("loading", "加载中")} />
        </div>
      ) : null}

      {error ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("storage.load_failed", "加载失败")} description={error} />
        </SettingsCard>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <p className="py-4 text-sm text-neutral-500 dark:text-neutral-400">
          {t("storage.empty", "还没有自定义存储。添加 Cloudflare R2、S3 兼容存储或 WebDAV 后，新上传的文件会优先存到这里，容量不再受默认存储限制。")}
        </p>
      ) : null}

      {items.map((item) => {
        const percent = item.quotaBytes > 0 ? Math.min(100, Math.round((item.usedBytes / item.quotaBytes) * 100)) : 0;
        return (
          <SettingsCard key={item.id} tone={item.status === "ok" || !item.enabled ? "default" : "warning"}>
            <SettingsCardHeader
              title={item.name}
              description={`${typeLabel(item.type)} · ${item.endpoint}${item.bucket ? ` / ${item.bucket}` : ""}${item.folder ? ` / ${item.folder}` : ""}`}
              badge={statusBadge(item)}
            />
            <SettingsCardBody>
              <div className="space-y-2 text-sm text-neutral-600 dark:text-neutral-300">
                <p>
                  {t("storage.usage", "已存 {{count}} 个文件，{{size}}", {
                    count: item.fileCount,
                    size: formatBytes(item.usedBytes),
                  })}
                  {item.quotaBytes > 0
                    ? ` / ${t("storage.quota_limit", "上限")} ${formatBytes(item.quotaBytes)}（${percent}%）`
                    : ` · ${t("storage.quota_unlimited", "不限容量")}`}
                  {` · ${t("storage.priority", "优先级")} ${item.priority}`}
                </p>
                {item.quotaBytes > 0 ? (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div className="h-full rounded-full bg-theme" style={{ width: `${percent}%` }} />
                  </div>
                ) : null}
                {item.lastError ? (
                  <p className="whitespace-pre-wrap break-all text-rose-600 dark:text-rose-300">{item.lastError}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button
                    secondary
                    title={testingId === item.id ? t("storage.testing", "测试中…") : t("storage.test", "测试连接")}
                    disabled={testingId !== null}
                    onClick={() => testItem(item)}
                  />
                  <Button secondary title={t("storage.edit", "编辑")} onClick={() => { setFormMessage(null); setForm(formFromItem(item)); }} />
                  <Button
                    secondary
                    title={item.enabled ? t("storage.disable", "停用") : t("storage.enable", "启用")}
                    onClick={() => toggleEnabled(item)}
                  />
                  {item.status !== "ok" ? (
                    <Button secondary title={t("storage.reset", "重置状态")} onClick={() => resetStatus(item)} />
                  ) : null}
                  <Button secondary title={t("storage.delete", "删除")} onClick={() => removeItem(item)} />
                </div>
              </div>
            </SettingsCardBody>
          </SettingsCard>
        );
      })}

      <Modal
        isOpen={form !== null}
        onRequestClose={() => setForm(null)}
        contentLabel={t("storage.form_title", "存储配置")}
        size="lg"
        panelClassName="p-6"
        shouldCloseOnOverlayClick={false}
      >
        {form ? (
          <div className="flex max-h-[80vh] w-full flex-col gap-4 overflow-y-auto">
            <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">
              {form.id ? t("storage.edit_title", "编辑存储") : t("storage.add", "添加存储")}
            </h1>

            <Field label={t("storage.field.type", "存储类型")}>
              <select
                className={inputClass}
                value={form.type}
                disabled={form.id !== undefined}
                onChange={(event) => selectType(event.target.value as StorageType)}
              >
                <option value="r2">{t("storage.type.r2_full", "Cloudflare R2（其他账号 / 其他桶，使用 S3 API）")}</option>
                <option value="s3">{t("storage.type.s3_full", "S3 兼容（AWS S3、MinIO、B2、阿里云 OSS、腾讯云 COS 等）")}</option>
                <option value="webdav">{t("storage.type.webdav", "WebDAV")}</option>
              </select>
            </Field>

            <Field label={t("storage.field.name", "名称")}>
              <input className={inputClass} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder={t("storage.field.name_ph", "例如：R2-图床 2")} />
            </Field>

            <Field
              label={form.type === "webdav" ? t("storage.field.dav_url", "WebDAV 地址") : t("storage.field.endpoint", "Endpoint")}
              hint={
                form.type === "r2"
                  ? "https://<账户ID>.r2.cloudflarestorage.com"
                  : form.type === "webdav"
                    ? "https://dav.example.com/remote.php/dav/files/用户名"
                    : "https://s3.us-east-1.amazonaws.com"
              }
            >
              <input className={inputClass} value={form.endpoint} onChange={(e) => patch({ endpoint: e.target.value })} placeholder="https://" />
            </Field>

            {form.type !== "webdav" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Bucket">
                  <input className={inputClass} value={form.bucket} onChange={(e) => patch({ bucket: e.target.value })} />
                </Field>
                <Field label="Region" hint={form.type === "r2" ? t("storage.field.region_r2", "R2 填 auto") : undefined}>
                  <input className={inputClass} value={form.region} onChange={(e) => patch({ region: e.target.value })} />
                </Field>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={form.type === "webdav" ? t("storage.field.username", "用户名") : "Access Key ID"}>
                <input className={inputClass} value={form.accessKey} onChange={(e) => patch({ accessKey: e.target.value })} autoComplete="off" />
              </Field>
              <Field
                label={form.type === "webdav" ? t("storage.field.password", "密码 / 应用专用密码") : "Secret Access Key"}
                hint={form.hasSecret ? t("storage.field.secret_saved", "已保存（加密存储），留空表示不修改") : undefined}
              >
                <input
                  className={inputClass}
                  type="password"
                  value={form.secret}
                  onChange={(e) => patch({ secret: e.target.value })}
                  autoComplete="new-password"
                  placeholder={form.hasSecret ? "••••••••" : ""}
                />
              </Field>
            </div>

            <Field label={t("storage.field.folder", "存放目录（可选）")} hint={t("storage.field.folder_hint", "文件会放在这个目录下，例如 blog/media")}>
              <input className={inputClass} value={form.folder} onChange={(e) => patch({ folder: e.target.value })} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("storage.field.priority", "优先级")} hint={t("storage.field.priority_hint", "数字越大越优先")}>
                <input className={inputClass} type="number" value={form.priority} onChange={(e) => patch({ priority: e.target.value })} />
              </Field>
              <Field label={t("storage.field.quota", "容量上限（GB，可选）")} hint={t("storage.field.quota_hint", "留空为不限制；用满后自动换下一个存储")}>
                <input className={inputClass} type="number" min="0" step="0.1" value={form.quotaGb} onChange={(e) => patch({ quotaGb: e.target.value })} />
              </Field>
            </div>

            <Field
              label={t("storage.field.public_url", "公开访问域名（可选）")}
              hint={t("storage.field.public_url_hint", "存储自己的公开域名或 CDN 域名，用于下面的“直链跳转”")}
            >
              <input className={inputClass} value={form.publicUrl} onChange={(e) => patch({ publicUrl: e.target.value })} placeholder="https://img.example.com" />
            </Field>

            <CheckField
              label={t("storage.field.redirect", "读取时直链跳转（节省 Worker 流量）")}
              hint={t("storage.field.redirect_hint", "开启后访问文件会 302 跳转到上面的公开域名，文章里的链接不变；需要该域名能公开读取文件。")}
              checked={form.redirect}
              onChange={(value) => patch({ redirect: value })}
            />
            {form.type === "s3" ? (
              <CheckField
                label={t("storage.field.path_style", "使用路径风格（Path-style）")}
                hint={t("storage.field.path_style_hint", "MinIO 等自建存储需要开启；AWS S3 / 阿里云 OSS / 腾讯云 COS 请关闭。")}
                checked={form.forcePathStyle}
                onChange={(value) => patch({ forcePathStyle: value })}
              />
            ) : null}
            <CheckField label={t("storage.field.enabled", "启用")} checked={form.enabled} onChange={(value) => patch({ enabled: value })} />

            {form.type !== "webdav" ? (
              <details className="rounded-xl border border-black/10 p-3 text-xs text-neutral-600 dark:border-white/10 dark:text-neutral-300">
                <summary className="cursor-pointer font-medium">{t("storage.cors_title", "大文件（视频）直传需要给存储桶配置 CORS")}</summary>
                <p className="mt-2">
                  {t("storage.cors_desc", "超过 8MB 的文件会由浏览器直接上传到存储桶，不经过服务器（不受 100MB 限制）。请在存储桶的 CORS 设置里允许你的站点域名使用 PUT：")}
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-black/5 p-3 dark:bg-white/10">{`[{
  "AllowedOrigins": ["https://你的博客域名"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600
}]`}</pre>
                <p className="mt-2">{t("storage.cors_fallback", "未配置 CORS 时会自动回退为服务器中转上传（最大约 95MB）。")}</p>
              </details>
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("storage.webdav_note", "WebDAV 不支持浏览器直传，文件会经服务器中转上传（单个文件最大约 95MB）。")}
              </p>
            )}

            {formMessage ? (
              <p className={`whitespace-pre-wrap break-all text-sm ${formMessage.ok ? "text-green-600 dark:text-green-400" : "text-rose-600 dark:text-rose-300"}`}>
                {formMessage.text}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button secondary title={t("cancel", "取消")} onClick={() => setForm(null)} />
              <Button
                secondary
                title={testing ? t("storage.testing", "测试中…") : t("storage.test", "测试连接")}
                disabled={testing || saving}
                onClick={runFormTest}
              />
              <Button title={saving ? t("saving", "保存中…") : t("save", "保存")} disabled={saving || testing} onClick={save} />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
