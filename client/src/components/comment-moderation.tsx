import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import type { PendingComment } from "@rin/api";
import { client } from "../app/runtime";
import { Button } from "@rin/ui";
import { useAlert } from "./dialog";

/**
 * 评论审核列表：配合「评论需要审核」开关使用。
 * 站长可以在这里通过或删除待审核的评论。
 */
export function CommentModerationList() {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [items, setItems] = useState<PendingComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await client.comment.pending();
      if (error) {
        showAlert(t("settings.comment.moderation.load_failed$message", { message: String(error.value) }));
        setItems([]);
        return;
      }
      setItems(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, [showAlert, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: number) {
    setBusyId(id);
    try {
      const { error } = await client.comment.approve(id);
      if (error) {
        showAlert(t("settings.comment.moderation.action_failed$message", { message: String(error.value) }));
        return;
      }
      setItems((current) => current.filter((item) => item.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: number) {
    setBusyId(id);
    try {
      const { error } = await client.comment.delete(id);
      if (error) {
        showAlert(t("settings.comment.moderation.action_failed$message", { message: String(error.value) }));
        return;
      }
      setItems((current) => current.filter((item) => item.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-full rounded-xl border border-neutral-200/70 p-3 dark:border-neutral-700/70">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">
          {t("settings.comment.moderation.title")}
          {items.length > 0 ? ` (${items.length})` : ""}
        </div>
        <Button title={t("settings.comment.moderation.refresh")} onClick={() => void load()} disabled={loading} />
      </div>

      {loading ? (
        <div className="flex justify-center py-3">
          <ReactLoading width="1em" height="1em" type="spin" color="#FC466B" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-neutral-500">{t("settings.comment.moderation.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const author = item.user?.username || item.guestName || t("anonymous");
            return (
              <li key={item.id} className="rounded-lg bg-neutral-50 p-2 text-sm dark:bg-neutral-800/60">
                <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
                  <span className="font-medium text-neutral-700 dark:text-neutral-200">{author}</span>
                  {item.feed?.title ? <span>· {item.feed.title}</span> : null}
                  <span>· {item.createdAt}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{item.content}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    title={t("settings.comment.moderation.approve")}
                    onClick={() => void approve(item.id)}
                    disabled={busyId === item.id}
                  />
                  <Button
                    title={t("settings.comment.moderation.delete")}
                    secondary
                    onClick={() => void remove(item.id)}
                    disabled={busyId === item.id}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AlertUI />
    </div>
  );
}
