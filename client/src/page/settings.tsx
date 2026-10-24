import { Modal, SearchableSelect, SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, SettingsCardRow } from "@rin/ui";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client, oauth_url } from "../app/runtime";
import { Button } from "../components/button";
import { useAlert } from "../components/dialog";
import { HeaderLayoutPreview } from "../components/site-header/layout-preview";
import {
  HEADER_BEHAVIOR_OPTIONS,
  HEADER_LAYOUT_OPTIONS,
  normalizeHeaderBehavior,
  normalizeHeaderLayout,
} from "../components/site-header/layout-options";
import { FEED_CARD_VARIANTS, normalizeFeedCardVariant } from "../components/feed-card-options";
import { FeedCardPreview } from "../components/feed-card-preview";
import { FEED_LAYOUT_OPTIONS, normalizeFeedLayout } from "../components/feed-layout-options";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { applyThemeColor, normalizeThemeColor } from "../utils/theme-color";
import { AISummarySettings } from "./settings-ai";
import { ItemButton, ItemImageInput, ItemInput, ItemSwitch, ItemTitle, ItemWithUpload } from "./settings-items";
import {
  areSettingsDraftsEqual,
  buildAIConfigDraftValue,
  createSettingsConfigWrappers,
  importWordPressFile,
  loadSettingsConfigState,
  mergeSessionConfig,
  saveSettingsConfigState,
  type SettingsDraft,
  updateDraftConfig,
  uploadFavicon,
} from "./settings-helpers";

import "../utils/thumb.css";

const WEBHOOK_METHOD_OPTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((value) => ({
  label: value,
  value,
}));

const THEME_COLOR_OPTIONS = [
  { label: "Rose", value: "#fc466b" },
  { label: "Violet", value: "#7c3aed" },
  { label: "Blue", value: "#2563eb" },
  { label: "Teal", value: "#0f766e" },
  { label: "Orange", value: "#ea580c" },
];

export function Settings() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [isOpen, setIsOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgList, setMsgList] = useState<{ title: string; reason: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookTestMessage, setWebhookTestMessage] = useState("");
  const [draft, setDraft] = useState<SettingsDraft>({ clientConfig: {}, serverConfig: {} });
  const [initialDraft, setInitialDraft] = useState<SettingsDraft>({ clientConfig: {}, serverConfig: {} });
  const [hasStoredAiApiKey, setHasStoredAiApiKey] = useState(false);
  const ref = useRef(false);
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const initialDraftRef = useRef<SettingsDraft>({ clientConfig: {}, serverConfig: {} });
  const { showAlert, AlertUI } = useAlert();

  // ================= 备份 & 恢复交互状态 =================
  const [backupActionLoading, setBackupActionLoading] = useState(false);

  // 1. 备份前确认弹窗
  const [backupConfirmModal, setBackupConfirmModal] = useState<{
    open: boolean;
    type: "local" | "cloud";
    previewData?: any;
    targetStorage?: any;
  }>({ open: false, type: "local" });

  // 2. 备份成功通知弹窗
  const [backupSuccessModal, setBackupSuccessModal] = useState<{
    open: boolean;
    filename: string;
    path: string;
    target: string;
    counts: any;
  } | null>(null);

  // 3. 云端历史备份选择列表弹窗
  const [cloudBackupsModal, setCloudBackupsModal] = useState<{
    open: boolean;
    loading: boolean;
    items: any[];
    target: string;
    error?: string;
  }>({ open: false, loading: false, items: [], target: "" });

  // 3.1 手动输入云端路径状态
  const [manualCloudKey, setManualCloudKey] = useState("");

  // 4. 恢复前确认弹窗（包含待恢复数据预览）
  const [restoreConfirmModal, setRestoreConfirmModal] = useState<{
    open: boolean;
    source: "local" | "cloud";
    localFile?: File | null;
    cloudKey?: string;
    filename: string;
    exportedAt: string;
    counts: any;
  } | null>(null);

  function getDraftThemeColor(nextDraft: SettingsDraft) {
    return typeof nextDraft.clientConfig["theme.color"] === "string" ? nextDraft.clientConfig["theme.color"] : undefined;
  }

  useEffect(() => {
    if (ref.current) return;
    loadSettingsConfigState()
      .then((state) => {
        setDraft(state.draft);
        setInitialDraft(state.draft);
        initialDraftRef.current = state.draft;
        setHasStoredAiApiKey(state.hasStoredAiApiKey);
        mergeSessionConfig(state.draft.clientConfig);
        applyThemeColor(getDraftThemeColor(state.draft));
      })
      .catch((err: any) => {
        showAlert(t("settings.get_config_failed$message", { message: err.message }));
      })
      .finally(() => {
        setLoading(false);
      });
    ref.current = true;

    return () => {
      applyThemeColor(getDraftThemeColor(initialDraftRef.current));
    };
  }, [showAlert, t]);

  const { clientConfig, serverConfig } = useMemo(() => createSettingsConfigWrappers(draft), [draft]);
  const aiValue = useMemo(() => buildAIConfigDraftValue(draft, hasStoredAiApiKey), [draft, hasStoredAiApiKey]);
  const hasUnsavedChanges = !areSettingsDraftsEqual(draft, initialDraft);
  const themeColorValue = normalizeThemeColor(String(clientConfig.get("theme.color") ?? "#fc466b"));
  const feedLayoutValue = normalizeFeedLayout(String(clientConfig.get("feed.layout") ?? "list"));
  const feedCardVariantValue = normalizeFeedCardVariant(String(clientConfig.get("feed.card_variant") ?? "default"));
  const previewSiteName = String(clientConfig.get("site.name") ?? clientConfig.default("site.name") ?? "Rin");
  const previewSiteAvatar = String(clientConfig.get("site.avatar") ?? clientConfig.default("site.avatar") ?? "");

  function setConfigValue(type: "client" | "server", key: string, value: unknown) {
    setDraft((current) => updateDraftConfig(current, type, key, value));
  }

  function handleReset() {
    setDraft(initialDraft);
    applyThemeColor(getDraftThemeColor(initialDraft));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const state = await saveSettingsConfigState(draft);
      setDraft(state.draft);
      setInitialDraft(state.draft);
      initialDraftRef.current = state.draft;
      setHasStoredAiApiKey(state.hasStoredAiApiKey || aiValue.apiKey.trim().length > 0);
      mergeSessionConfig(state.draft.clientConfig);
      window.dispatchEvent(new Event("storage"));
      showAlert(t("settings.ai_summary.save_success"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showAlert(t("settings.update_failed$message", { message }));
    } finally {
      setSaving(false);
    }
  }

  async function handleFaviconChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      await uploadFavicon(file, t, showAlert);
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const { data, error } = await importWordPressFile(file);
      if (data) {
        setMsg(t("settings.import_success$success$skipped", { success: data.imported, skipped: 0 }));
        setMsgList([]);
        setIsOpen(true);
      } else if (error) {
        showAlert(t("settings.import_failed$message", { message: error.value }));
      }
    }
  }

  async function handleTestWebhook() {
    setTestingWebhook(true);
    try {
      const { data, error } = await client.config.testWebhook({
        webhook_url: String(serverConfig.get("webhook_url") ?? ""),
        "webhook.method": String(serverConfig.get("webhook.method") ?? ""),
        "webhook.content_type": String(serverConfig.get("webhook.content_type") ?? ""),
        "webhook.headers": String(serverConfig.get("webhook.headers") ?? ""),
        "webhook.body_template": String(serverConfig.get("webhook.body_template") ?? ""),
        test_message: webhookTestMessage,
      });

      if (error || !data || !data.success) {
        const message = error?.value || data?.error || t("settings.webhook.test.failed");
        const details = data?.details ? `\n${data.details}` : "";
        showAlert(`${message}${details}`);
        return;
      }

      showAlert(t("settings.webhook.test.success"));
    } finally {
      setTestingWebhook(false);
    }
  }

  // ================= 备份 & 恢复处理函数 =================

  // 1. 点击触发前置预览与确认弹窗
  const openBackupConfirm = async (type: "local" | "cloud") => {
    setBackupActionLoading(true);
    try {
      const { data } = await client.backup.getPreview();
      setBackupConfirmModal({
        open: true,
        type,
        previewData: data?.preview,
        targetStorage: data?.targetStorage,
      });
    } catch {
      setBackupConfirmModal({ open: true, type });
    } finally {
      setBackupActionLoading(false);
    }
  };

  // 2. 确认开始执行备份
  const executeConfirmedBackup = async () => {
    const type = backupConfirmModal.type;
    setBackupConfirmModal({ ...backupConfirmModal, open: false });
    setBackupActionLoading(true);

    try {
      if (type === "local") {
        const res = await client.backup.download();
        if (!res.ok) {
          showAlert(res.error || "下载备份失败");
        } else {
          setBackupSuccessModal({
            open: true,
            filename: res.filename || "rin-backup-xxxx.json",
            path: "已下载至当前设备浏览器默认下载目录",
            target: "本地设备",
            counts: backupConfirmModal.previewData,
          });
        }
      } else {
        const { data, error } = await client.backup.exportToStorage();
        if (error || !data || !data.ok) {
          showAlert(`云端备份失败: ${error?.value || "存储桶写入异常"}`);
        } else {
          setBackupSuccessModal({
            open: true,
            filename: data.filename,
            path: data.path,
            target: data.target,
            counts: data.metadata?.counts,
          });
          setManualCloudKey(data.path);
        }
      }
    } catch (e: any) {
      showAlert(`备份过程中出错: ${e.message}`);
    } finally {
      setBackupActionLoading(false);
    }
  };

  // 3. 打开云端备份历史选择列表
  const openCloudBackupsList = async () => {
    setCloudBackupsModal({ open: true, loading: true, items: [], target: "" });
    try {
      const { data, error } = await client.backup.listStorageBackups();
      if (error || !data || !data.ok) {
        showAlert(error?.value || "获取云端备份列表失败，请检查存储桶连接");
        setCloudBackupsModal({ open: false, loading: false, items: [], target: "" });
      } else {
        setCloudBackupsModal({
          open: true,
          loading: false,
          items: data.items || [],
          target: data.target || "云端存储桶",
          error: data.error,
        });
        if (data.items && data.items.length > 0 && !manualCloudKey) {
          setManualCloudKey(data.items[0].key);
        }
      }
    } catch (e: any) {
      showAlert(`读取异常: ${e.message}`);
      setCloudBackupsModal({ open: false, loading: false, items: [], target: "" });
    }
  };

  // 4. 选择本地 JSON 文件 -> 客户端预解析 -> 弹出数据核对窗口
  const handleSelectLocalFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || parsed.app !== "rin" || !parsed.data) {
        showAlert("无效的备份文件：该文件不是由 Rin 生成的标准数据镜像。");
        return;
      }
      setRestoreConfirmModal({
        open: true,
        source: "local",
        localFile: file,
        filename: file.name,
        exportedAt: parsed.exportedAt || "未知",
        counts: parsed.metadata?.counts || {
          feeds: parsed.data.feeds?.length ?? 0,
          comments: parsed.data.comments?.length ?? 0,
          moments: parsed.data.moments?.length ?? 0,
          friends: parsed.data.friends?.length ?? 0,
        },
      });
    } catch (err: any) {
      showAlert(`读取备份文件出错: ${err.message}`);
    }
  };

  // 5. 点击云端列表项 -> 弹出核对确认窗口
  const handleSelectCloudBackupItem = (item: any) => {
    setCloudBackupsModal({ ...cloudBackupsModal, open: false });
    setRestoreConfirmModal({
      open: true,
      source: "cloud",
      cloudKey: item.key,
      filename: item.filename,
      exportedAt: item.createdAt,
      counts: item.metadata?.counts || {},
    });
  };

  // 6. 最终确认执行恢复操作
  const executeConfirmedRestore = async () => {
    if (!restoreConfirmModal) return;
    const { source, localFile, cloudKey } = restoreConfirmModal;
    setRestoreConfirmModal(null);
    setBackupActionLoading(true);

    try {
      let resData: any = null;
      let resError: any = null;

      if (source === "local" && localFile) {
        const { data, error } = await client.backup.importFromFile(localFile);
        resData = data;
        resError = error;
      } else if (source === "cloud" && cloudKey) {
        const { data, error } = await client.backup.restoreFromStorage(cloudKey);
        resData = data;
        resError = error;
      }

      if (resError || !resData || !resData.ok) {
        showAlert(`恢复失败: ${resError?.value || resData?.error || "写入异常"}`);
      } else {
        const counts = resData.counts || {};
        showAlert(
          `🎉 全量数据恢复成功！\n成功还原: ${counts.feeds ?? 0} 篇文章、${counts.comments ?? 0} 条评论、${counts.moments ?? 0} 条动态、${counts.friends ?? 0} 个友链。\n点击确定将刷新页面。`,
          () => {
            window.location.reload();
          }
        );
      }
    } catch (err: any) {
      showAlert(`恢复过程出错: ${err.message}`);
    } finally {
      setBackupActionLoading(false);
    }
  };

  return (
    <div className="flex w-full flex-col">
      <Helmet>
        <title>{`${t("settings.title")} - ${siteConfig.name}`}</title>
      </Helmet>
      <main className="w-full rounded-2xl bg-w" aria-label={t("main_content")}>
        <div className="flex flex-col items-start space-y-2">
          {(loading || saving) && <ReactLoading width="1em" height="1em" type="spin" color="#FC466B" />}
          <ItemTitle title={t("settings.site.title")} />
          <ItemInput
            title={t("settings.site.name.title")}
            description={t("settings.site.name.desc")}
            configKeyTitle={t("settings.site.name.label")}
            value={String(clientConfig.get("site.name") ?? "")}
            placeholder={String(clientConfig.default("site.name") ?? t("settings.site.name.label"))}
            onChange={(value) => {
              setConfigValue("client", "site.name", value);
            }}
          />
          <ItemInput
            title={t("settings.site.description.title")}
            description={t("settings.site.description.desc")}
            configKeyTitle={t("settings.site.description.label")}
            value={String(clientConfig.get("site.description") ?? "")}
            placeholder={String(clientConfig.default("site.description") ?? t("settings.site.description.label"))}
            onChange={(value) => {
              setConfigValue("client", "site.description", value);
            }}
          />
          <ItemImageInput
            title={t("settings.site.avatar.title")}
            description={t("settings.site.avatar.desc")}
            configKeyTitle={t("settings.site.avatar.label")}
            value={String(clientConfig.get("site.avatar") ?? "")}
            placeholder={String(clientConfig.default("site.avatar") ?? t("settings.site.avatar.label"))}
            onChange={(value) => {
              setConfigValue("client", "site.avatar", value);
            }}
            onError={showAlert}
          />
          <ItemInput
            title={t("settings.site.page_size.title")}
            description={t("settings.site.page_size.desc")}
            configKeyTitle={t("settings.site.page_size.label")}
            value={String(clientConfig.get("site.page_size") ?? "")}
            placeholder={String(clientConfig.default("site.page_size") ?? t("settings.site.page_size.label"))}
            onChange={(value) => {
              setConfigValue("client", "site.page_size", value);
            }}
          />

          <ItemTitle title={t("settings.personalization.title")} />
          <div className="w-full">
            <SettingsCard>
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title={t("settings.header_layout.title")}
                    description={t("settings.header_layout.desc")}
                  />
                }
                action={
                  <SearchableSelect
                    value={normalizeHeaderLayout(String(clientConfig.get("header.layout") ?? "classic"))}
                    onChange={(value) => {
                      setConfigValue("client", "header.layout", value);
                    }}
                    options={HEADER_LAYOUT_OPTIONS.map((value) => ({
                      value,
                      label: t(`settings.header_layout.options.${value}`),
                    }))}
                    placeholder={t("settings.header_layout.title")}
                    emptyLabel={t("no_more")}
                    searchable={false}
                  />
                }
              />
              <SettingsCardBody>
                <div className="grid gap-3 md:grid-cols-2">
                  {HEADER_LAYOUT_OPTIONS.map((value) => (
                    <HeaderLayoutPreview
                      key={value}
                      data={{
                        avatar: previewSiteAvatar,
                        name: previewSiteName,
                        themeColor: themeColorValue,
                      }}
                      layout={value}
                      selected={normalizeHeaderLayout(String(clientConfig.get("header.layout") ?? "classic")) === value}
                      title={t(`settings.header_layout.options.${value}`)}
                      description={t(`settings.header_layout.preview.${value}`)}
                      onClick={() => {
                        setConfigValue("client", "header.layout", value);
                      }}
                    />
                  ))}
                </div>
              </SettingsCardBody>
              <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
                <SettingsCardRow
                  header={
                    <SettingsCardHeader
                      title={t("settings.feed_layout.title")}
                      description={t("settings.feed_layout.desc")}
                    />
                  }
                  action={
                    <SearchableSelect
                      value={feedLayoutValue}
                      onChange={(value) => {
                        setConfigValue("client", "feed.layout", value);
                      }}
                      options={FEED_LAYOUT_OPTIONS.map((value) => ({
                        value,
                        label: t(`settings.feed_layout.options.${value}`),
                      }))}
                      placeholder={t("settings.feed_layout.title")}
                      emptyLabel={t("no_more")}
                      searchable={false}
                    />
                  }
                />
              </div>
              <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
                <SettingsCardRow
                  header={
                    <SettingsCardHeader
                      title={t("settings.feed_card.title")}
                      description={t("settings.feed_card.desc")}
                    />
                  }
                  action={
                    <SearchableSelect
                      value={feedCardVariantValue}
                      onChange={(value) => {
                        setConfigValue("client", "feed.card_variant", value);
                      }}
                      options={FEED_CARD_VARIANTS.map((value) => ({
                        value,
                        label: t(`settings.feed_card.options.${value}`),
                      }))}
                      placeholder={t("settings.feed_card.title")}
                      emptyLabel={t("no_more")}
                      searchable={false}
                    />
                  }
                />
                <SettingsCardBody>
                  <div className="grid gap-3 md:grid-cols-2">
                    {FEED_CARD_VARIANTS.map((value) => (
                      <FeedCardPreview
                        key={value}
                        variant={value}
                        selected={feedCardVariantValue === value}
                        title={t(`settings.feed_card.options.${value}`)}
                        description={t(`settings.feed_card.preview.${value}`)}
                        onClick={() => {
                          setConfigValue("client", "feed.card_variant", value);
                        }}
                      />
                    ))}
                  </div>
                </SettingsCardBody>
              </div>
              <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
                <SettingsCardRow
                  header={
                    <SettingsCardHeader
                      title={t("settings.theme_color.title")}
                      description={t("settings.theme_color.desc")}
                    />
                  }
                  action={
                    <div className="text-sm font-medium t-primary">{themeColorValue}</div>
                  }
                />
                <SettingsCardBody>
                  <div className="flex flex-wrap gap-3">
                    {THEME_COLOR_OPTIONS.map((option) => {
                      const selected = themeColorValue === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setConfigValue("client", "theme.color", option.value);
                            applyThemeColor(option.value);
                          }}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-all ${
                            selected
                              ? "border-theme bg-theme/5 shadow-sm shadow-theme/10"
                              : "border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20"
                          }`}
                        >
                          <span
                            className="h-6 w-6 rounded-full border border-black/10 dark:border-white/10"
                            style={{ backgroundColor: option.value }}
                          />
                          <span className="text-sm t-primary">{t(`settings.theme_color.options.${option.label.toLowerCase()}`)}</span>
                          {selected ? <i className="ri-check-line text-theme" /> : null}
                        </button>
                      );
                    })}
                    <label className="flex items-center gap-3 rounded-xl border border-black/10 px-3 py-2 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20">
                      <input
                        type="color"
                        value={themeColorValue}
                        onChange={(event) => {
                          const normalized = normalizeThemeColor(event.target.value);
                          setConfigValue("client", "theme.color", normalized);
                          applyThemeColor(normalized);
                        }}
                        className="color-input-reset h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
                      />
                      <span className="text-sm t-primary">{t("settings.theme_color.custom")}</span>
                    </label>
                  </div>
                </SettingsCardBody>
              </div>
              <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
                <SettingsCardRow
                  header={
                    <SettingsCardHeader
                      title={t("settings.header_behavior.title")}
                      description={t("settings.header_behavior.desc")}
                    />
                  }
                  action={
                    <SearchableSelect
                      value={normalizeHeaderBehavior(String(clientConfig.get("header.behavior") ?? "fixed"))}
                      onChange={(value) => {
                        setConfigValue("client", "header.behavior", value);
                      }}
                      options={HEADER_BEHAVIOR_OPTIONS.map((value) => ({
                        value,
                        label: t(`settings.header_behavior.options.${value}`),
                      }))}
                      placeholder={t("settings.header_behavior.title")}
                      emptyLabel={t("no_more")}
                      searchable={false}
                    />
                  }
                />
              </div>
            </SettingsCard>
          </div>

          <ItemTitle title={t("settings.other.title")} />
          <ItemSwitch
            title={t("settings.login.enable.title")}
            description={t("settings.login.enable.desc", { url: oauth_url })}
            checked={clientConfig.getBoolean("login.enabled")}
            onChange={(checked) => {
              setConfigValue("client", "login.enabled", checked);
            }}
          />
          <ItemSwitch
            title={t("settings.comment.enable.title")}
            description={t("settings.comment.enable.desc")}
            checked={clientConfig.getBoolean("comment.enabled")}
            onChange={(checked) => {
              setConfigValue("client", "comment.enabled", checked);
            }}
          />
          <ItemSwitch
            title={t("settings.counter.enable.title")}
            description={t("settings.counter.enable.desc")}
            checked={clientConfig.getBoolean("counter.enabled")}
            onChange={(checked) => {
              setConfigValue("client", "counter.enabled", checked);
            }}
          />
          <ItemSwitch
            title={t("settings.rss.title")}
            description={t("settings.rss.desc")}
            checked={clientConfig.getBoolean("rss")}
            onChange={(checked) => {
              setConfigValue("client", "rss", checked);
            }}
          />
          <ItemWithUpload
            title={t("settings.favicon.title")}
            description={t("settings.favicon.desc")}
            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
            onFileChange={handleFaviconChange}
          />
          <ItemInput
            title={t("settings.footer.title")}
            description={t("settings.footer.desc")}
            configKeyTitle="Footer HTML"
            value={String(clientConfig.get("footer") ?? "")}
            onChange={(value) => {
              setConfigValue("client", "footer", value);
            }}
          />

          <ItemTitle title={t("settings.webhook.title")} />
          <ItemInput
            title={t("settings.webhook.url.title")}
            description={t("settings.webhook.url.desc")}
            configKeyTitle="WEBHOOK_URL"
            value={String(serverConfig.get("webhook_url") ?? "")}
            placeholder="https://example.com/webhook"
            onChange={(value) => {
              setConfigValue("server", "webhook_url", value);
            }}
          />
          <div className="w-full">
            <SettingsCard>
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title={t("settings.webhook.method.title")}
                    description={t("settings.webhook.method.desc")}
                  />
                }
                action={
                  <SearchableSelect
                    value={String(serverConfig.get("webhook.method") ?? "")}
                    onChange={(value) => {
                      setConfigValue("server", "webhook.method", value);
                    }}
                    options={WEBHOOK_METHOD_OPTIONS}
                    placeholder={String(serverConfig.default("webhook.method") ?? "POST")}
                    searchPlaceholder={t("settings.webhook.method.title")}
                    emptyLabel={t("no_more")}
                    allowCustomValue
                    customValueLabel={(value) => `${t("update.title")}: ${value}`}
                  />
                }
              />
            </SettingsCard>
          </div>
          <ItemInput
            title={t("settings.webhook.content_type.title")}
            description={t("settings.webhook.content_type.desc")}
            configKeyTitle="Content-Type"
            value={String(serverConfig.get("webhook.content_type") ?? "")}
            placeholder={String(serverConfig.default("webhook.content_type") ?? "application/json")}
            onChange={(value) => {
              setConfigValue("server", "webhook.content_type", value);
            }}
          />
          <ItemInput
            title={t("settings.webhook.headers.title")}
            description={t("settings.webhook.headers.desc")}
            configKeyTitle={t("settings.webhook.headers.label")}
            value={String(serverConfig.get("webhook.headers") ?? "")}
            placeholder={String(serverConfig.default("webhook.headers") ?? "{}")}
            onChange={(value) => {
              setConfigValue("server", "webhook.headers", value);
            }}
          />
          <ItemInput
            title={t("settings.webhook.body_template.title")}
            description={t("settings.webhook.body_template.desc")}
            configKeyTitle={t("settings.webhook.body_template.label")}
            value={String(serverConfig.get("webhook.body_template") ?? "")}
            placeholder={String(serverConfig.default("webhook.body_template") ?? "")}
            onChange={(value) => {
              setConfigValue("server", "webhook.body_template", value);
            }}
          />
          <div className="w-full">
            <SettingsCard>
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title={t("settings.webhook.test.title")}
                    description={t("settings.webhook.test.desc")}
                  />
                }
                action={
                  <Button
                    title={testingWebhook ? t("settings.webhook.test.sending") : t("settings.webhook.test.button")}
                    onClick={handleTestWebhook}
                    disabled={testingWebhook}
                  />
                }
              />
              <SettingsCardBody>
                <textarea
                  value={webhookTestMessage}
                  placeholder={t("settings.webhook.test.placeholder")}
                  onChange={(event) => {
                    setWebhookTestMessage(event.target.value);
                  }}
                  className="min-h-28 w-full rounded-xl border border-black/10 bg-w px-4 py-3 text-sm t-primary outline-none transition-colors placeholder:text-neutral-400 focus:border-black/20 focus:ring-2 focus:ring-theme/10 dark:border-white/10 dark:placeholder:text-neutral-500 dark:focus:border-white/20"
                />
              </SettingsCardBody>
            </SettingsCard>
          </div>

          <ItemTitle title={t("settings.friend.title")} />
          <ItemSwitch
            title={t("settings.friend.apply.title")}
            description={t("settings.friend.apply.desc")}
            checked={Boolean(clientConfig.get("friend_apply_enable"))}
            onChange={(checked) => {
              setConfigValue("client", "friend_apply_enable", checked);
            }}
          />
          <ItemSwitch
            title={t("settings.friend.health.title")}
            description={t("settings.friend.health.desc")}
            checked={Boolean(serverConfig.get("friend_crontab"))}
            onChange={(checked) => {
              setConfigValue("server", "friend_crontab", checked);
            }}
          />
          <ItemInput
            title={t("settings.friend.health.ua.title")}
            description={t("settings.friend.health.ua.desc")}
            configKeyTitle="User-Agent"
            value={String(serverConfig.get("friend_ua") ?? "")}
            placeholder={String(serverConfig.default("friend_ua") ?? "User-Agent")}
            onChange={(value) => {
              setConfigValue("server", "friend_ua", value);
            }}
          />

          <ItemTitle title={t("settings.maintenance.title")} />

          {/* ============ ★ 一键全量数据备份模块 ============ */}
          <div className="w-full">
            <SettingsCard>
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title="数据全量备份（跨账号/防封归档）"
                    description="将包含所有文章、草稿、分类、评论、动态、友链、站点设置与已绑定存储配置全部打包。在执行前会展示数据概况与备份目标路径确认。"
                  />
                }
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      title={backupActionLoading ? "请稍候..." : "下载备份到本地"}
                      onClick={() => openBackupConfirm("local")}
                      disabled={backupActionLoading}
                    />
                    <Button
                      secondary
                      title={backupActionLoading ? "请稍候..." : "备份到云端存储桶"}
                      onClick={() => openBackupConfirm("cloud")}
                      disabled={backupActionLoading}
                    />
                  </div>
                }
              />
            </SettingsCard>
          </div>

          {/* ============ ★ 全量灾难恢复模块（本地文件 / 云端存储双选） ============ */}
          <div className="w-full">
            <SettingsCard tone="warning">
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title="数据恢复与灾难迁移（本地 / 云端双选）"
                    description="支持选择本地 .json 备份包恢复，或直接从当前绑定的存储桶（S3/R2/WebDAV）恢复历史备份。恢复前会弹窗核对数据详情与二次确认。"
                    badge={<SettingsBadge tone="warning">覆盖式写入</SettingsBadge>}
                  />
                }
                action={
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={restoreFileRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleSelectLocalFile}
                    />
                    <Button
                      title="从本地文件恢复"
                      onClick={() => restoreFileRef.current?.click()}
                      disabled={backupActionLoading}
                    />
                    <Button
                      secondary
                      title="从云端存储恢复"
                      onClick={openCloudBackupsList}
                      disabled={backupActionLoading}
                    />
                  </div>
                }
              />
            </SettingsCard>
          </div>

          <ItemSwitch
            title={t("settings.cache.enabled.title")}
            description={t("settings.cache.enabled.desc")}
            checked={Boolean(clientConfig.getBoolean("cache.enabled"))}
            onChange={(checked) => {
              setConfigValue("client", "cache.enabled", checked);
            }}
          />
          <ItemButton
            title={t("settings.cache.clear.title")}
            description={t("settings.cache.clear.desc")}
            buttonTitle={t("clear")}
            onConfirm={async () => {
              await client.config.clearCache().then(({ error }) => {
                if (error) {
                  showAlert(t("settings.cache.clear_failed$message", { message: error.value }));
                }
              });
            }}
            alertTitle={t("settings.cache.clear.confirm.title")}
            alertDescription={t("settings.cache.clear.confirm.desc")}
          />
          <ItemWithUpload
            title={t("settings.wordpress.title")}
            description={t("settings.wordpress.desc")}
            accept="application/xml"
            onFileChange={onFileChange}
          />

          <AISummarySettings
            value={aiValue}
            onChange={(updates) => {
              if (updates.enabled !== undefined) {
                setConfigValue("server", "ai_summary.enabled", updates.enabled);
              }
              if (updates.provider !== undefined) {
                setConfigValue("server", "ai_summary.provider", updates.provider);
              }
              if (updates.model !== undefined) {
                setConfigValue("server", "ai_summary.model", updates.model);
              }
              if (updates.apiUrl !== undefined) {
                setConfigValue("server", "ai_summary.api_url", updates.apiUrl);
              }
              if (updates.apiKey !== undefined) {
                setConfigValue("server", "ai_summary.api_key", updates.apiKey);
              }
            }}
          />

          {hasUnsavedChanges && (
            <div className="sticky bottom-4 z-20 mt-6 w-full pb-2">
              <SettingsCard tone="warning">
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title={t("settings.ai_summary.save.title")}
                    description={t("settings.ai_summary.unsaved_changes")}
                    badge={<SettingsBadge tone="warning">{t("settings.ai_summary.unsaved_changes")}</SettingsBadge>}
                  />
                }
                action={
                  <>
                    <Button secondary title={t("reset")} onClick={handleReset} disabled={saving} />
                    <Button title={t("save")} onClick={handleSave} disabled={saving || loading} />
                  </>
                }
              />
              </SettingsCard>
            </div>
          )}
        </div>
      </main>

      {/* 1. 备份前确认弹窗 */}
      <Modal
        isOpen={backupConfirmModal.open}
        onRequestClose={() => setBackupConfirmModal({ ...backupConfirmModal, open: false })}
        contentLabel="确认备份"
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start w-full">
          <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">
            {backupConfirmModal.type === "local" ? "确认导出本地备份？" : "确认备份到云端存储桶？"}
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            {backupConfirmModal.type === "local"
              ? "系统将把博客全部数据打包生成为一个 JSON 快照，并通过浏览器直接下载到您的电脑或手机中。"
              : "系统将把博客全部数据打包，并上传归档到您当前已绑定的云端存储桶中（自动保留最新的 3 份备份，旧备份自动清理淘汰）。"}
          </p>

          <div className="mt-4 w-full rounded-xl bg-secondary p-4 space-y-2 text-sm t-primary">
            <p className="font-semibold text-xs uppercase tracking-wider text-theme">即将备份的数据概览：</p>
            <div className="grid grid-cols-2 gap-2 pt-1 text-xs sm:text-sm">
              <p>📄 文章数量: <span className="font-semibold">{backupConfirmModal.previewData?.feedsCount ?? "计算中..."}</span> 篇</p>
              <p>💬 评论条数: <span className="font-semibold">{backupConfirmModal.previewData?.commentsCount ?? "计算中..."}</span> 条</p>
              <p>⚡ 动态数量: <span className="font-semibold">{backupConfirmModal.previewData?.momentsCount ?? "计算中..."}</span> 条</p>
              <p>🤝 友链数量: <span className="font-semibold">{backupConfirmModal.previewData?.friendsCount ?? "计算中..."}</span> 个</p>
              <p>💾 存储配置: <span className="font-semibold">{backupConfirmModal.previewData?.storagesCount ?? "计算中..."}</span> 个</p>
            </div>
            <div className="pt-2 border-t border-black/5 dark:border-white/5 text-xs text-neutral-500">
              <p>📍 备份目标: <span className="font-semibold t-primary">
                {backupConfirmModal.type === "local"
                  ? "本地设备（浏览器下载文件）"
                  : `${backupConfirmModal.targetStorage?.name || "绑定的存储桶"} -> ${backupConfirmModal.targetStorage?.folder || "backups"}/`}
              </span></p>
            </div>
          </div>

          <div className="mt-6 flex w-full justify-end gap-2">
            <Button secondary title="取消" onClick={() => setBackupConfirmModal({ ...backupConfirmModal, open: false })} />
            <Button
              title={backupActionLoading ? "正在打包..." : "确认开始备份"}
              onClick={executeConfirmedBackup}
              disabled={backupActionLoading}
            />
          </div>
        </div>
      </Modal>

      {/* 2. 备份成功信息回执弹窗 */}
      <Modal
        isOpen={Boolean(backupSuccessModal?.open)}
        onRequestClose={() => setBackupSuccessModal(null)}
        contentLabel="备份成功"
        panelClassName="p-6"
      >
        {backupSuccessModal ? (
          <div className="flex flex-col items-start w-full">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <i className="ri-checkbox-circle-fill text-2xl" />
              <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">备份打包成功！</h1>
            </div>
            <p className="mt-2 text-sm text-neutral-500">您的数据已经生成并安全写入，详细信息如下：</p>

            <div className="mt-4 w-full rounded-xl bg-secondary p-4 space-y-2 text-xs sm:text-sm t-primary">
              <p>🏷️ <b>备份文件名：</b> <span className="font-mono">{backupSuccessModal.filename}</span></p>
              <p>📦 <b>目标存储：</b> <span>{backupSuccessModal.target}</span></p>
              <p>📍 <b>存储路径：</b> <span className="font-mono break-all">{backupSuccessModal.path}</span></p>
              {backupSuccessModal.counts ? (
                <div className="pt-2 border-t border-black/5 dark:border-white/5 grid grid-cols-2 gap-1 text-neutral-500">
                  <span>包含文章: {backupSuccessModal.counts.feeds ?? 0} 篇</span>
                  <span>包含评论: {backupSuccessModal.counts.comments ?? 0} 条</span>
                  <span>包含动态: {backupSuccessModal.counts.moments ?? 0} 条</span>
                  <span>包含友链: {backupSuccessModal.counts.friends ?? 0} 个</span>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex w-full justify-end">
              <Button title="好的，我知道了" onClick={() => setBackupSuccessModal(null)} />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 3. 云端备份历史选择列表弹窗 */}
      <Modal
        isOpen={cloudBackupsModal.open}
        onRequestClose={() => setCloudBackupsModal({ ...cloudBackupsModal, open: false })}
        contentLabel="选择云端备份恢复"
        size="lg"
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start w-full">
          <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">从云端存储桶恢复数据</h1>
          <p className="mt-1 text-sm text-neutral-500">
            当前存储桶（{cloudBackupsModal.target}）历史快照列表：
          </p>

          <div className="mt-4 w-full max-h-80 overflow-y-auto space-y-3">
            {cloudBackupsModal.loading ? (
              <div className="flex items-center justify-center p-8 text-neutral-400 gap-2">
                <ReactLoading type="spin" color="#FC466B" width={20} height={20} />
                <span>正在读取存储桶...</span>
              </div>
            ) : cloudBackupsModal.items.length === 0 ? (
              <div className="p-4 rounded-xl bg-secondary text-sm text-neutral-500 space-y-2">
                <p>存储桶索引暂未读取到列表，但您的备份文件依然保存在存储桶中。</p>
                {cloudBackupsModal.error ? (
                  <p className="text-xs text-amber-500 font-mono">调试信息: {cloudBackupsModal.error}</p>
                ) : null}
              </div>
            ) : (
              cloudBackupsModal.items.map((item, idx) => (
                <div
                  key={item.key || idx}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-black/10 dark:border-white/10 bg-secondary gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold truncate t-primary">{item.filename}</p>
                    <p className="text-xs text-neutral-400 mt-1">
                      备份时间: {new Date(item.createdAt).toLocaleString()} · 包含文章: {item.metadata?.counts?.feeds ?? 0} 篇
                    </p>
                  </div>
                  <Button
                    title="选择此备份"
                    onClick={() => handleSelectCloudBackupItem(item)}
                  />
                </div>
              ))
            )}
          </div>

          {/* 手动直接指定备份文件路径恢复兜底 */}
          <div className="mt-5 w-full pt-4 border-t border-black/5 dark:border-white/5 space-y-2">
            <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
              或者直接指定云端备份文件路径恢复：
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="例如：backups/rin-backup-2026-10-24T01-43-36.json"
                value={manualCloudKey}
                onChange={(e) => setManualCloudKey(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-xs font-mono t-primary outline-none focus:border-theme dark:border-white/10"
              />
              <Button
                title={backupActionLoading ? "读取中..." : "读取并恢复"}
                disabled={backupActionLoading}
                onClick={async () => {
                  const key = manualCloudKey.trim();
                  if (!key) {
                    showAlert("请输入云端备份文件完整路径");
                    return;
                  }
                  setBackupActionLoading(true);
                  try {
                    const { data, error } = await client.backup.inspectStorageBackup(key);
                    if (error || !data || !data.ok) {
                      showAlert(`未能读取到备份文件: ${error?.value || "路径错误或文件不存在"}`);
                    } else {
                      setCloudBackupsModal({ ...cloudBackupsModal, open: false });
                      setRestoreConfirmModal({
                        open: true,
                        source: "cloud",
                        cloudKey: data.key,
                        filename: data.filename,
                        exportedAt: data.exportedAt,
                        counts: data.metadata?.counts || {},
                      });
                    }
                  } catch (e: any) {
                    showAlert(`读取失败: ${e.message}`);
                  } finally {
                    setBackupActionLoading(false);
                  }
                }}
              />
            </div>
          </div>

          <div className="mt-6 flex w-full justify-end">
            <Button secondary title="关闭" onClick={() => setCloudBackupsModal({ ...cloudBackupsModal, open: false })} />
          </div>
        </div>
      </Modal>

      {/* 4. 恢复前确认弹窗（展示备份内详细内容并提示覆盖警告） */}
      <Modal
        isOpen={Boolean(restoreConfirmModal?.open)}
        onRequestClose={() => setRestoreConfirmModal(null)}
        contentLabel="确认恢复备份"
        panelClassName="p-6"
      >
        {restoreConfirmModal ? (
          <div className="flex flex-col items-start w-full">
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <i className="ri-error-warning-fill text-2xl" />
              <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">确认恢复此份备份？</h1>
            </div>
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-300 font-medium">
              ⚠️ 高风险覆盖警示：恢复将用此备份包彻底覆盖当前站点的文章、动态、评论、友链和自定义配置！此操作无法撤销！
            </p>

            <div className="mt-4 w-full rounded-xl bg-secondary p-4 space-y-2 text-xs sm:text-sm t-primary">
              <p className="font-semibold text-xs uppercase tracking-wider text-theme">即将恢复的数据镜像详情：</p>
              <p>📦 <b>恢复来源：</b> {restoreConfirmModal.source === "local" ? "本地上传文件" : "云端存储桶文件"}</p>
              <p>🏷️ <b>备份文件名：</b> <span className="font-mono">{restoreConfirmModal.filename}</span></p>
              <p>🕒 <b>备份生成时间：</b> <span>{new Date(restoreConfirmModal.exportedAt).toLocaleString()}</span></p>
              <div className="pt-2 border-t border-black/5 dark:border-white/5 grid grid-cols-2 gap-2 text-xs">
                <span>📄 文章: {restoreConfirmModal.counts?.feeds ?? 0} 篇</span>
                <span>💬 评论: {restoreConfirmModal.counts?.comments ?? 0} 条</span>
                <span>⚡ 动态: {restoreConfirmModal.counts?.moments ?? 0} 条</span>
                <span>🤝 友链: {restoreConfirmModal.counts?.friends ?? 0} 个</span>
              </div>
            </div>

            <div className="mt-6 flex w-full justify-end gap-2">
              <Button secondary title="取消" onClick={() => setRestoreConfirmModal(null)} disabled={backupActionLoading} />
              <Button
                title={backupActionLoading ? "正在恢复写入..." : "确认覆盖并恢复"}
                onClick={executeConfirmedRestore}
                disabled={backupActionLoading}
              />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* WordPress 导入弹窗 */}
      <Modal
        isOpen={isOpen}
        onRequestClose={() => setIsOpen(false)}
        contentLabel={t("settings.import_result")}
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start">
          <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">{t("settings.import_result")}</h1>
          <p className="mt-2 text-base t-primary">{msg}</p>
          <div className="flex w-full flex-col items-start">
            <p className="mt-4 text-base font-bold t-primary">{t("settings.import_skipped")}</p>
            <ul className="flex max-h-64 w-full flex-col items-start overflow-auto">
              {msgList.map((item, idx) => (
                <li key={idx} className="text-sm t-primary">
                  {t("settings.import_skipped_item$title$reason", { title: item.title, reason: item.reason })}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex w-full flex-col items-center">
            <button
              onClick={() => {
                setIsOpen(false);
              }}
              className="h-min rounded-xl bg-theme px-8 py-2 text-white"
            >
              {t("close")}
            </button>
          </div>
        </div>
      </Modal>
      <AlertUI />
    </div>
  );
}
