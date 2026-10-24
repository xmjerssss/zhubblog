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
    type: "local" | "cloud" | "github";
    previewData?: any;
    targetStorage?: any;
    targetGitHub?: any;
  }>({ open: false, type: "local" });

  // 2. 备份成功通知弹窗
  const [backupSuccessModal, setBackupSuccessModal] = useState<{
    open: boolean;
    filename: string;
    path: string;
    target: string;
    counts: any;
    extraNote?: string;
  } | null>(null);

  // 3. 存储桶备份选择列表弹窗
  const [cloudBackupsModal, setCloudBackupsModal] = useState<{
    open: boolean;
    loading: boolean;
    items: any[];
    target: string;
    error?: string;
  }>({ open: false, loading: false, items: [], target: "" });

  const [manualCloudKey, setManualCloudKey] = useState("backups/rin-backup-2026-10-24T01-43-36.json");

  // 3.1 GitHub 备份选择列表弹窗
  const [githubBackupsModal, setGithubBackupsModal] = useState<{
    open: boolean;
    loading: boolean;
    items: any[];
    target: string;
    branch: string;
  }>({ open: false, loading: false, items: [], target: "", branch: "main" });

  // 3.2 GitHub 备份配置管理弹窗
  const [githubConfigModal, setGithubConfigModal] = useState<{
    open: boolean;
    owner: string;
    repo: string;
    branch: string;
    path: string;
    token: string;
    hasToken: boolean;
    configured: boolean;
    saving: boolean;
    testing: boolean;
    testResult?: string;
  }>({
    open: false,
    owner: "",
    repo: "",
    branch: "main",
    path: "backups",
    token: "",
    hasToken: false,
    configured: false,
    saving: false,
    testing: false,
  });

  // 4. 恢复前确认弹窗
  const [restoreConfirmModal, setRestoreConfirmModal] = useState<{
    open: boolean;
    source: "local" | "cloud" | "github";
    localFile?: File | null;
    cloudKey?: string;
    githubPath?: string;
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

  const openBackupConfirm = async (type: "local" | "cloud" | "github") => {
    setBackupActionLoading(true);
    try {
      const { data } = await client.backup.getPreview();
      setBackupConfirmModal({
        open: true,
        type,
        previewData: data?.preview,
        targetStorage: data?.targetStorage,
        targetGitHub: data?.targetGitHub,
      });
    } catch {
      setBackupConfirmModal({ open: true, type });
    } finally {
      setBackupActionLoading(false);
    }
  };

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
      } else if (type === "cloud") {
        const { data, error } = await client.backup.exportToStorage();
        if (error || !data || !data.ok) {
          showAlert(`存储桶备份失败: ${error?.value || "写入异常"}`);
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
      } else if (type === "github") {
        const { data, error } = await client.backup.exportToGitHub();
        if (error || !data || !data.ok) {
          showAlert(`GitHub 备份失败: ${error?.value || "提交异常，请检查 Token 权限"}`);
        } else {
          setBackupSuccessModal({
            open: true,
            filename: data.filename,
            path: data.path,
            target: data.target,
            counts: data.metadata?.counts,
            extraNote: `Commit SHA: ${data.commitSha}`,
          });
        }
      }
    } catch (e: any) {
      showAlert(`备份过程中出错: ${e.message}`);
    } finally {
      setBackupActionLoading(false);
    }
  };

  const openCloudBackupsList = async () => {
    setCloudBackupsModal({ open: true, loading: true, items: [], target: "" });
    try {
      const { data, error } = await client.backup.listStorageBackups();
      if (error || !data || !data.ok) {
        showAlert(error?.value || "获取存储桶备份列表失败");
        setCloudBackupsModal({ open: false, loading: false, items: [], target: "" });
      } else {
        setCloudBackupsModal({
          open: true,
          loading: false,
          items: data.items || [],
          target: data.target || "云端存储桶",
          error: data.error,
        });
        if (data.items && data.items.length > 0) {
          setManualCloudKey(data.items[0].key);
        }
      }
    } catch (e: any) {
      showAlert(`读取异常: ${e.message}`);
      setCloudBackupsModal({ open: false, loading: false, items: [], target: "" });
    }
  };

  const openGitHubBackupsList = async () => {
    setGithubBackupsModal({ open: true, loading: true, items: [], target: "", branch: "main" });
    try {
      const { data, error } = await client.backup.listGitHubBackups();
      if (error || !data || !data.ok) {
        showAlert(error?.value || "获取 GitHub 备份列表失败，请先确认 GitHub 配置是否正确");
        setGithubBackupsModal({ open: false, loading: false, items: [], target: "", branch: "main" });
      } else {
        setGithubBackupsModal({
          open: true,
          loading: false,
          items: data.items || [],
          target: data.target,
          branch: data.branch,
        });
      }
    } catch (e: any) {
      showAlert(`读取 GitHub 异常: ${e.message}`);
      setGithubBackupsModal({ open: false, loading: false, items: [], target: "", branch: "main" });
    }
  };

  const openGitHubConfigDialog = async () => {
    setGithubConfigModal((prev) => ({ ...prev, open: true, testResult: undefined }));
    try {
      const { data } = await client.backup.getGitHubConfig();
      if (data) {
        setGithubConfigModal({
          open: true,
          owner: data.owner || "",
          repo: data.repo || "",
          branch: data.branch || "main",
          path: data.path || "backups",
          token: "",
          hasToken: data.hasToken,
          configured: data.configured,
          saving: false,
          testing: false,
          testResult: undefined,
        });
      }
    } catch {}
  };

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

  const handleSelectGitHubBackupItem = async (item: any) => {
    setGithubBackupsModal({ ...githubBackupsModal, open: false });
    setBackupActionLoading(true);
    try {
      const { data, error } = await client.backup.inspectGitHubBackup(item.path);
      if (error || !data || !data.ok) {
        showAlert(`未能读取 GitHub 备份内容: ${error?.value || "文件解析错误"}`);
      } else {
        setRestoreConfirmModal({
          open: true,
          source: "github",
          githubPath: data.path || data.key || item.path,
          filename: data.filename,
          exportedAt: data.exportedAt,
          counts: data.metadata?.counts || {},
        });
      }
    } catch (e: any) {
      showAlert(`读取异常: ${e.message}`);
    } finally {
      setBackupActionLoading(false);
    }
  };

  const executeConfirmedRestore = async () => {
    if (!restoreConfirmModal) return;
    const { source, localFile, cloudKey, githubPath } = restoreConfirmModal;
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
      } else if (source === "github" && githubPath) {
        const { data, error } = await client.backup.restoreFromGitHub(githubPath);
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

          {/* ============ ★ GitHub 异地私有仓库备份与恢复 ============ */}
          <div className="w-full">
            <SettingsCard tone="default">
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title="GitHub 私有仓库自动备份（极度推荐 • 异地容灾）"
                    description="将博客所有数据直接作为一个版本提交到您的 GitHub 私有仓库中。完全独立于 Cloudflare 架构，具备永久提交历史，即便主机或域名丢失，数据依然安全无虞。"
                    badge={<SettingsBadge tone="success">跨云独立容灾</SettingsBadge>}
                  />
                }
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      secondary
                      title="配置 GitHub 仓库"
                      onClick={openGitHubConfigDialog}
                    />
                    <Button
                      title={backupActionLoading ? "请稍候..." : "备份到 GitHub 仓库"}
                      onClick={() => openBackupConfirm("github")}
                      disabled={backupActionLoading}
                    />
                    <Button
                      secondary
                      title="从 GitHub 恢复"
                      onClick={openGitHubBackupsList}
                      disabled={backupActionLoading}
                    />
                  </div>
                }
              />
            </SettingsCard>
          </div>

          {/* ============ ★ 一键全量数据备份模块 ============ */}
          <div className="w-full">
            <SettingsCard>
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title="数据全量备份（本地 / 存储桶）"
                    description="将所有文章、草稿、分类、评论、动态、友链、站点设置打包。支持直接下载到手机/电脑，或存入已绑定的存储桶（保留最近 3 份）。"
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
                      title={backupActionLoading ? "请稍候..." : "备份到存储桶"}
                      onClick={() => openBackupConfirm("cloud")}
                      disabled={backupActionLoading}
                    />
                  </div>
                }
              />
            </SettingsCard>
          </div>

          {/* ============ ★ 全量灾难恢复模块（本地 / 存储桶） ============ */}
          <div className="w-full">
            <SettingsCard tone="warning">
              <SettingsCardRow
                header={
                  <SettingsCardHeader
                    title="数据恢复与灾难迁移（本地 / 存储桶）"
                    description="从本地 .json 文件恢复，或从当前绑定的存储桶恢复历史快照。"
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
                      title="从存储桶恢复"
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
            {backupConfirmModal.type === "local"
              ? "确认导出本地备份？"
              : backupConfirmModal.type === "github"
                ? "确认备份到 GitHub 私有仓库？"
                : "确认备份到云端存储桶？"}
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            {backupConfirmModal.type === "local"
              ? "系统将把博客全部数据打包生成为一个 JSON 快照，并通过浏览器直接下载到您的电脑或手机中。"
              : backupConfirmModal.type === "github"
                ? "系统将把博客全部数据打包成快照，并通过 GitHub API 自动提交（Commit）到您绑定的 GitHub 私有仓库中。"
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
                  : backupConfirmModal.type === "github"
                    ? `GitHub 仓库: ${backupConfirmModal.targetGitHub?.repo || "未配置"}`
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
              <p>📦 <b>目标归档：</b> <span>{backupSuccessModal.target}</span></p>
              <p>📍 <b>存储路径：</b> <span className="font-mono break-all">{backupSuccessModal.path}</span></p>
              {backupSuccessModal.extraNote ? (
                <p>🔗 <b>附加信息：</b> <span className="font-mono">{backupSuccessModal.extraNote}</span></p>
              ) : null}
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

      {/* 3.1 GitHub 备份配置管理弹窗 */}
      <Modal
        isOpen={githubConfigModal.open}
        onRequestClose={() => setGithubConfigModal({ ...githubConfigModal, open: false })}
        contentLabel="配置 GitHub 私有备份仓库"
        size="md"
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start w-full gap-3">
          <div className="flex items-center gap-2">
            <i className="ri-github-fill text-2xl t-primary" />
            <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">GitHub 私有仓库备份设置</h1>
          </div>
          <p className="text-xs text-neutral-500">
            建议在 GitHub 创建一个 <b>Private（私有）</b> 仓库用于备份。访问令牌（PAT）将使用 AES-GCM 强加密保存在数据库中。
          </p>

          <div className="w-full space-y-3 mt-2">
            <div>
              <label className="text-xs font-semibold t-primary block mb-1">GitHub 用户名或组织名 (Owner)</label>
              <input
                type="text"
                placeholder="例如：xmjerssss"
                value={githubConfigModal.owner}
                onChange={(e) => setGithubConfigModal({ ...githubConfigModal, owner: e.target.value })}
                className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
              />
            </div>

            <div>
              <label className="text-xs font-semibold t-primary block mb-1">仓库名称 (Repo)</label>
              <input
                type="text"
                placeholder="例如：blog-backups (必须为 Private 仓库)"
                value={githubConfigModal.repo}
                onChange={(e) => setGithubConfigModal({ ...githubConfigModal, repo: e.target.value })}
                className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold t-primary block mb-1">分支 (Branch)</label>
                <input
                  type="text"
                  placeholder="main"
                  value={githubConfigModal.branch}
                  onChange={(e) => setGithubConfigModal({ ...githubConfigModal, branch: e.target.value })}
                  className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
                />
              </div>
              <div>
                <label className="text-xs font-semibold t-primary block mb-1">目录路径 (Path)</label>
                <input
                  type="text"
                  placeholder="backups"
                  value={githubConfigModal.path}
                  onChange={(e) => setGithubConfigModal({ ...githubConfigModal, path: e.target.value })}
                  className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold t-primary block mb-1">
                GitHub 个人访问令牌 (Personal Access Token)
                {githubConfigModal.hasToken ? (
                  <span className="ml-2 text-emerald-500 font-normal">（已加密保存，留空为不修改）</span>
                ) : null}
              </label>
              <input
                type="password"
                placeholder={githubConfigModal.hasToken ? "已保存（留空表示不修改）" : "ghp_xxxxxxxxxxxxxxxxxxxx"}
                value={githubConfigModal.token}
                onChange={(e) => setGithubConfigModal({ ...githubConfigModal, token: e.target.value })}
                className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm font-mono t-primary outline-none focus:border-theme dark:border-white/10"
              />
              <p className="text-[11px] text-neutral-400 mt-1">
                支持直接在上方输入 Token 点击【测试连接】。需要具有 <b>repo</b> 权限（或细粒度 Token 赋予目标私有仓库的 <b>Contents: Read and write</b> 权限）。
              </p>
            </div>

            {githubConfigModal.testResult ? (
              <p className="text-xs p-3 rounded-lg bg-secondary text-neutral-600 dark:text-neutral-300 font-mono whitespace-pre-line leading-relaxed">
                {githubConfigModal.testResult}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex w-full justify-between items-center">
            <Button
              secondary
              title={githubConfigModal.testing ? "测试中..." : "测试连接"}
              disabled={githubConfigModal.testing || githubConfigModal.saving}
              onClick={async () => {
                const owner = githubConfigModal.owner.trim();
                const repo = githubConfigModal.repo.trim();
                const token = githubConfigModal.token.trim();

                if (!owner || !repo) {
                  setGithubConfigModal((prev) => ({ ...prev, testResult: "❌ 请先填写 GitHub 用户名和仓库名" }));
                  return;
                }
                if (!githubConfigModal.hasToken && !token) {
                  setGithubConfigModal((prev) => ({ ...prev, testResult: "❌ 请输入 GitHub Personal Access Token" }));
                  return;
                }

                setGithubConfigModal((prev) => ({ ...prev, testing: true, testResult: "正在连接 GitHub 验证..." }));
                try {
                  const { data, error } = await client.backup.testGitHubConnection({
                    owner,
                    repo,
                    token: token || undefined,
                  });

                  if (error || !data || !data.ok) {
                    setGithubConfigModal((prev) => ({
                      ...prev,
                      testing: false,
                      testResult: `❌ 失败: ${error?.value || "无法连接仓库，请检查 Token 权限"}`,
                    }));
                  } else {
                    setGithubConfigModal((prev) => ({
                      ...prev,
                      testing: false,
                      testResult: `✅ ${data.message}`,
                    }));
                  }
                } catch (e: any) {
                  setGithubConfigModal((prev) => ({ ...prev, testing: false, testResult: `❌ 异常: ${e.message}` }));
                }
              }}
            />

            <div className="flex gap-2">
              <Button secondary title="取消" onClick={() => setGithubConfigModal({ ...githubConfigModal, open: false })} />
              <Button
                title={githubConfigModal.saving ? "保存中..." : "保存配置"}
                disabled={githubConfigModal.saving || githubConfigModal.testing}
                onClick={async () => {
                  const owner = githubConfigModal.owner.trim();
                  const repo = githubConfigModal.repo.trim();
                  const token = githubConfigModal.token.trim();

                  if (!owner || !repo) {
                    showAlert("请填写完整 GitHub 用户名和仓库名");
                    return;
                  }
                  if (!githubConfigModal.hasToken && !token) {
                    showAlert("请输入 GitHub Personal Access Token");
                    return;
                  }
                  setGithubConfigModal((prev) => ({ ...prev, saving: true }));
                  try {
                    const { data, error } = await client.backup.saveGitHubConfig({
                      owner,
                      repo,
                      branch: githubConfigModal.branch.trim(),
                      path: githubConfigModal.path.trim(),
                      token: token || undefined,
                    });
                    if (error || !data || !data.ok) {
                      showAlert(`保存失败: ${error?.value || "写入异常"}`);
                    } else {
                      showAlert("GitHub 备份配置保存成功！");
                      setGithubConfigModal((prev) => ({
                        ...prev,
                        open: false,
                        owner,
                        repo,
                        hasToken: true,
                        configured: true,
                        token: "",
                      }));
                    }
                  } catch (e: any) {
                    showAlert(`保存异常: ${e.message}`);
                  } finally {
                    setGithubConfigModal((prev) => ({ ...prev, saving: false }));
                  }
                }}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* 3.2 GitHub 备份选择列表弹窗 */}
      <Modal
        isOpen={githubBackupsModal.open}
        onRequestClose={() => setGithubBackupsModal({ ...githubBackupsModal, open: false })}
        contentLabel="从 GitHub 仓库恢复"
        size="lg"
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start w-full">
          <div className="flex items-center gap-2">
            <i className="ri-github-fill text-2xl t-primary" />
            <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">从 GitHub 仓库恢复数据</h1>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            仓库 <b>{githubBackupsModal.target}</b>（分支: {githubBackupsModal.branch}）中保存的快照：
          </p>

          <div className="mt-4 w-full max-h-80 overflow-y-auto space-y-3">
            {githubBackupsModal.loading ? (
              <div className="flex items-center justify-center p-8 text-neutral-400 gap-2">
                <ReactLoading type="spin" color="#FC466B" width={20} height={20} />
                <span>正在获取 GitHub 仓库快照...</span>
              </div>
            ) : githubBackupsModal.items.length === 0 ? (
              <div className="p-4 rounded-xl bg-secondary text-sm text-neutral-500">
                <p>该仓库指定目录中暂未发现任何备份快照文件（以 rin-backup- 开头的 json 文件）。</p>
              </div>
            ) : (
              githubBackupsModal.items.map((item, idx) => (
                <div
                  key={item.sha || idx}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-black/10 dark:border-white/10 bg-secondary gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold truncate t-primary">{item.filename}</p>
                    <p className="text-xs text-neutral-400 mt-1">
                      备份时间: {item.createdAt} · 大小: {Math.round((item.size || 0) / 1024)} KB · Commit SHA: {item.sha?.slice(0, 7)}
                    </p>
                  </div>
                  <Button
                    title="选择此备份"
                    onClick={() => handleSelectGitHubBackupItem(item)}
                  />
                </div>
              ))
            )}
          </div>

          <div className="mt-6 flex w-full justify-end">
            <Button secondary title="关闭" onClick={() => setGithubBackupsModal({ ...githubBackupsModal, open: false })} />
          </div>
        </div>
      </Modal>

      {/* 3.3 存储桶备份历史选择列表弹窗 */}
      <Modal
        isOpen={cloudBackupsModal.open}
        onRequestClose={() => setCloudBackupsModal({ ...cloudBackupsModal, open: false })}
        contentLabel="选择存储桶备份恢复"
        size="lg"
        panelClassName="p-6"
      >
        <div className="flex flex-col items-start w-full">
          <h1 className="text-xl font-bold tracking-[-0.02em] t-primary">从存储桶恢复数据</h1>
          <p className="mt-1 text-sm text-neutral-500">
            当前存储桶（{cloudBackupsModal.target}）历史备份快照：
          </p>

          <div className="mt-4 w-full max-h-80 overflow-y-auto space-y-3">
            {cloudBackupsModal.loading ? (
              <div className="flex items-center justify-center p-8 text-neutral-400 gap-2">
                <ReactLoading type="spin" color="#FC466B" width={20} height={20} />
                <span>正在读取存储桶...</span>
              </div>
            ) : cloudBackupsModal.items.length === 0 ? (
              <div className="p-4 rounded-xl bg-secondary text-sm text-neutral-500 space-y-2">
                <p>存储桶索引暂未获取到，但文件已在存储桶中。请在下方直接输入完整路径恢复。</p>
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

          <div className="mt-5 w-full pt-4 border-t border-black/5 dark:border-white/5 space-y-2">
            <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
              或直接指定存储桶备份文件完整路径恢复：
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
                    showAlert("请输入完整文件路径，例如：backups/rin-backup-2026-10-24T01-43-36.json");
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
                        cloudKey: data.key || data.path || key,
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
            <p className="text-[11px] text-neutral-400">
              *注意：路径中<b>不需要包含存储桶名字</b>，必须带有 <b>.json</b> 后缀。
            </p>
          </div>

          <div className="mt-6 flex w-full justify-end">
            <Button secondary title="关闭" onClick={() => setCloudBackupsModal({ ...cloudBackupsModal, open: false })} />
          </div>
        </div>
      </Modal>

      {/* 4. 恢复前确认弹窗 */}
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
              <p>📦 <b>恢复来源：</b> {
                restoreConfirmModal.source === "local"
                  ? "本地上传文件"
                  : restoreConfirmModal.source === "github"
                    ? "GitHub 仓库快照"
                    : "云端存储桶文件"
              }</p>
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
