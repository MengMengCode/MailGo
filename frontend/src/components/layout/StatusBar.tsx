import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import {
  WifiOff,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RotateCw,
} from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useSyncStore } from "@/stores/sync.store";
import { APP_VERSION } from "@/lib/version";

export function StatusBar() {
  const { t } = useTranslation();
  const batchMode = useAppStore((s) => s.batchMode);
  const selectedMessageIds = useAppStore((s) => s.selectedMessageIds);
  const networkStatus = useAppStore((s) => s.networkStatus);
  const activeFolderId = useAppStore((s) => s.activeFolderId);
  const activeView = useAppStore((s) => s.activeView);
  const phase = useSyncStore((s) => s.phase);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const errorMessage = useSyncStore((s) => s.errorMessage);

  return (
    <footer
      className="flex items-center justify-between px-4 h-7 border-t shrink-0 select-none text-label-12"
      style={{
        backgroundColor: "var(--mailgo-statusbar-bg)",
        borderColor: "var(--geist-border)",
        color: "var(--geist-secondary)",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {batchMode ? (
          <span>{t("batch.selected", { count: selectedMessageIds.size })}</span>
        ) : (
          <span className="truncate">
            {describeView(activeView, activeFolderId)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <SyncIndicator phase={phase} lastSyncAt={lastSyncAt} errorMessage={errorMessage} />
        {networkStatus === "offline" ? (
          <span
            className="flex items-center gap-1.5"
            style={{ color: "var(--geist-red-500)" }}
          >
            <WifiOff size={12} />
            {t("status.offline")}
          </span>
        ) : (
          <span
            className="flex items-center gap-1.5"
            style={{ color: "var(--geist-green-500)" }}
          >
            <CheckCircle2 size={12} />
            {t("status.online")}
          </span>
        )}
        <span>MailGo v{APP_VERSION}</span>
      </div>
    </footer>
  );
}

function SyncIndicator({
  phase,
  lastSyncAt,
  errorMessage,
}: {
  phase: "idle" | "syncing" | "error";
  lastSyncAt: string | null;
  errorMessage: string | null;
}) {
  const { t } = useTranslation();

  if (phase === "syncing") {
    return (
      <span
        className="flex items-center gap-1.5"
        style={{ color: "var(--geist-primary)" }}
        title={t("status.autoRefreshInProgress")}
      >
        <Loader2 size={12} className="spinner" />
        {t("settings.syncing")}
      </span>
    );
  }

  if (phase === "error") {
    return (
      <span
        className="flex items-center gap-1.5"
        style={{ color: "var(--geist-red-500)" }}
        title={errorMessage ?? ""}
      >
        <AlertCircle size={12} />
        {t("status.syncError")}
      </span>
    );
  }

  const rel = formatRelative(lastSyncAt);
  if (!rel) {
    return (
      <span
        className="flex items-center gap-1.5"
        style={{ color: "var(--geist-tertiary)" }}
        title={t("status.autoRefreshIdle")}
      >
        <RotateCw size={11} />
        {t("settings.neverSynced")}
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: "var(--geist-tertiary)" }}
      title={t("settings.lastSynced", { when: lastSyncAt ?? "" })}
    >
      <RotateCw size={11} />
      {t("settings.lastSynced", { when: rel })}
    </span>
  );
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  const t = i18n.t.bind(i18n);
  if (s < 5) return t("sidebar.justSynced");
  if (s < 60) return t("sidebar.secondsAgo", { seconds: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("sidebar.minutesAgo", { minutes: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("sidebar.hoursAgo", { hours: h });
  const d = Math.floor(h / 24);
  return t("sidebar.daysAgo", { days: d });
}

function describeView(view: string, folderId: number | null): string {
  const t = i18n.t.bind(i18n);
  switch (view) {
    case "inbox":
      return folderId ? `#${folderId}` : t("sidebar.inbox");
    case "compose":
      return t("compose.new");
    case "settings":
      return t("sidebar.settings");
    case "search":
      return t("search.title");
    case "starred":
      return t("sidebar.starred");
    case "drafts":
      return t("sidebar.drafts");
    default:
      return view;
  }
}
