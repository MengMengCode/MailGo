import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sun,
  Moon,
  Monitor,
  User,
  Bot,
  Info,
  Settings as SettingsIcon,
  Trash2,
  Plus,
  RefreshCw,
  RotateCw,
  Bell,
  Eye,
  Zap,
  Save,
  Upload,
  Globe,
  MessagesSquare,
  MailOpen,
  Shield,
  Download,
  Palette,
  Layers,
  Type,
  Maximize2,
  Sparkles,
  SlidersHorizontal,
  Image as ImageIcon,
  Check,
  Code2,
  LockKeyhole,
} from "lucide-react";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import {
  useDeleteAccount,
  useUpdateAccount,
} from "@/hooks/mutations/useAccountMutations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsApi, storageApi, pgpKeysApi, syncApi, authApi, type Account, type AppearanceSettings as AppearanceSettingsType } from "@/lib/api";
import { useAppStore, type ThemeMode } from "@/stores/appStore";
import { useAppearanceStore, markAppearanceEditing } from "@/stores/appearanceStore";
import { showToast } from "@/stores/toast.store";
import { confirm } from "@/stores/confirm.store";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { AddAccountWizard } from "@/components/AddAccountWizard";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { useSyncStore } from "@/stores/sync.store";
import { cn, setAppTimeZone } from "@/lib/utils";
import i18n, { LANG_KEY } from "@/lib/i18n";
import { getKeyFingerprint, generateKeyPair } from "@/lib/pgp";
import { useIsMobile } from "@/hooks/useBreakpoint";

type Tab = "general" | "accounts" | "appearance" | "ai" | "security" | "about";

const TABS: { id: Tab; labelKey: string; icon: typeof SettingsIcon }[] = [
  { id: "general", labelKey: "settings.general", icon: SettingsIcon },
  { id: "accounts", labelKey: "settings.accounts", icon: User },
  { id: "appearance", labelKey: "settings.appearance", icon: Sun },
  { id: "ai", labelKey: "settings.ai", icon: Bot },
  { id: "security", labelKey: "settings.security", icon: Shield },
  { id: "about", labelKey: "settings.about", icon: Info },
];

const FALLBACK_TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
];

function timezoneOptions() {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const values = intl.supportedValuesOf?.("timeZone") || FALLBACK_TIMEZONES;
  return Array.from(new Set(["UTC", "Asia/Shanghai", ...values])).sort();
}

export function SettingsView() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setTab = useAppStore((s) => s.setSettingsTab);
  const isMobile = useIsMobile();

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center px-4 lg:px-6 h-12 border-b shrink-0"
        style={{
          borderColor: "var(--geist-border)",
          backgroundColor: "var(--mailgo-sidebar-bg)",
          backdropFilter: "var(--mailgo-sidebar-backdrop)",
          WebkitBackdropFilter: "var(--mailgo-sidebar-backdrop)",
        }}
      >
        <h1 className="text-heading-16">{t("settings.title")}</h1>
      </div>
      {/* Mobile: horizontal scrollable tab bar */}
      {isMobile ? (
        <div
          className="flex gap-1 px-2 py-1.5 overflow-x-auto border-b shrink-0"
          style={{
            borderColor: "var(--geist-border)",
            backgroundColor: "var(--mailgo-sidebar-bg)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 h-8 rounded-geist text-label-13 whitespace-nowrap shrink-0 transition-colors",
                  tab === item.id
                    ? "text-[var(--geist-primary)] font-medium"
                    : "text-secondary",
                )}
                style={
                  tab === item.id
                    ? { backgroundColor: "var(--mailgo-sidebar-active)" }
                    : undefined
                }
              >
                <Icon size={13} />
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className={cn("flex-1 flex min-h-0", isMobile && "flex-col")}>
        {/* Desktop: vertical sidebar nav */}
        {!isMobile && (
          <div
            className="w-[220px] shrink-0 border-r py-2 px-2 overflow-y-auto"
            style={{
              borderColor: "var(--geist-border)",
              backgroundColor: "var(--mailgo-sidebar-bg)",
              backdropFilter: "var(--mailgo-sidebar-backdrop)",
              WebkitBackdropFilter: "var(--mailgo-sidebar-backdrop)",
            }}
            aria-label={t("settings.settingsNav")}
          >
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "w-full inline-flex items-center gap-2.5 px-3 h-9 rounded-geist text-label-14 transition-colors",
                    tab === item.id
                      ? "text-[var(--geist-primary)] font-medium"
                      : "text-secondary hover:text-[var(--geist-primary)]",
                  )}
                  style={
                    tab === item.id
                      ? { backgroundColor: "var(--mailgo-sidebar-active)" }
                      : undefined
                  }
                >
                  <Icon size={14} />
                  {t(item.labelKey)}
                </button>
              );
            })}
          </div>
        )}
        <div
          className={cn("flex-1 overflow-y-auto", isMobile ? "px-4 py-4" : "px-8 py-8")}
          style={{ backgroundColor: "var(--geist-bg-100)" }}
        >
          <div className={cn("mx-auto", isMobile ? "max-w-full" : "max-w-[720px]")}>
            {tab === "general" && <GeneralSettings />}
            {tab === "accounts" && <AccountsSettings />}
            {tab === "appearance" && <AppearanceSettings />}
            {tab === "ai" && <AISettings />}
            {tab === "security" && <SecuritySettings />}
            {tab === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== General ============================== */
function GeneralSettings() {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const qc = useQueryClient();

  const [form, setForm] = useState({
    app_timezone: "UTC",
    auto_refresh_enabled: "true",
    check_interval: "300",
    notifications_enabled: "true",
    autosave_interval: "10",
    retention_messages_days: "0",
    retention_attachments_days: "0",
    retention_images_days: "0",
    storage_limit_gb: "5",
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const get = (k: string) => settings.find((s) => s.key === k)?.value || "";
    setForm({
      app_timezone: get("app_timezone") || "UTC",
      auto_refresh_enabled: get("auto_refresh_enabled") || "true",
      check_interval: get("check_interval") || "300",
      notifications_enabled: get("notifications_enabled") || "true",
      autosave_interval: get("autosave_interval") || "10",
      retention_messages_days: get("retention_messages_days") || "0",
      retention_attachments_days: get("retention_attachments_days") || "0",
      retention_images_days: get("retention_images_days") || "0",
      storage_limit_gb: get("storage_limit_gb") || "5",
    });
    setDirty(false);
  }, [settings]);

  const patch = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      await Promise.all(
        Object.entries(form).map(([key, value]) =>
          settingsApi.update(key, value),
        ),
      );
    },
    onSuccess: () => {
      setAppTimeZone(form.app_timezone);
      qc.invalidateQueries({ queryKey: ["settings"] });
      showToast(t("settings.saved"), "success");
      setDirty(false);
    },
  });

  const changeLang = (lang: string) => {
    void i18n.changeLanguage(lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
    settingsApi.update("language", lang);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-heading-20">{t("settings.general")}</h2>
      <div className="card-padded space-y-5">
        <Select
          label={t("settings.language")}
          value={i18n.language || "zh-CN"}
          onChange={(e) => changeLang(e.target.value)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </Select>
        <div className="divider" />
        <Select
          label={t("settings.timezone")}
          value={form.app_timezone}
          onChange={(e) => patch("app_timezone", e.target.value)}
          hint={t("settings.timezoneHint")}
        >
          {timezoneOptions().map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        <div className="divider" />
        <AutoRefreshSettings form={form} patch={patch} />
        <div className="divider" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Bell
              size={16}
              className="mt-0.5 shrink-0"
              style={{ color: "var(--geist-secondary)" }}
            />
            <div>
              <p className="text-label-14 font-medium">
                {t("settings.enableNotifications")}
              </p>
              <p className="text-copy-13 text-secondary mt-0.5">
                {t("settings.enableNotificationsHint", "Show desktop notifications for new messages")}
              </p>
            </div>
          </div>
          <Switch
            checked={form.notifications_enabled === "true"}
            onChange={(v) => patch("notifications_enabled", String(v))}
          />
        </div>
        <div className="divider" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Save
              size={16}
              className="mt-0.5 shrink-0"
              style={{ color: "var(--geist-secondary)" }}
            />
            <div>
              <p className="text-label-14 font-medium">
                {t("settings.autosaveInterval")}
              </p>
              <p className="text-copy-13 text-secondary mt-0.5">
                {t("settings.autosaveIntervalHint")}
              </p>
            </div>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <Input
              className="w-[88px]"
              inputSize="small"
              type="number"
              min={0}
              max={300}
              value={form.autosave_interval}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || Number(v) < 0) return;
                patch("autosave_interval", v);
              }}
            />
            <span className="text-label-12 text-secondary">s</span>
          </div>
        </div>

        {/* ==================== Storage Management ==================== */}
        <div className="divider" />
        <StorageSection form={form} patch={patch} />
        <div className="flex justify-end pt-1">
          <Button
            size="small"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate()}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------- Storage Management --------- */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function getAvatarCacheSize(): number {
  try {
    const raw = localStorage.getItem("mailgo-avatar-cache");
    return raw ? raw.length * 2 : 0; // UTF-16 → bytes
  } catch {
    return 0;
  }
}

function StorageRow({
  color,
  labelKey,
  bytes,
  onClear,
}: {
  color: string;
  labelKey: string;
  bytes: number;
  onClear: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);
  const qc = useQueryClient();

  const handleClear = async () => {
    setClearing(true);
    try {
      await onClear();
      qc.invalidateQueries({ queryKey: ["storage-stats"] });
      showToast(t("settings.avatarCacheCleared"), "success");
    } catch {
      showToast(t("settings.clearAllFailed"), "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-geist border px-3 h-10"
      style={{
        borderColor: "var(--geist-border)",
        backgroundColor: "var(--geist-bg-100)",
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-label-12 text-secondary truncate">
          {t(labelKey)} {formatBytes(bytes)}
        </span>
      </div>
      <Button
        size="small"
        variant="tertiary"
        onClick={() => void handleClear()}
        disabled={bytes === 0 || clearing}
        loading={clearing}
      >
        {t("settings.clearCache")}
      </Button>
    </div>
  );
}

function AvatarCacheRow() {
  const { t } = useTranslation();
  const [size, setSize] = useState(() => getAvatarCacheSize());

  const clearCache = () => {
    try {
      localStorage.removeItem("mailgo-avatar-cache");
    } catch {
      /* ignore */
    }
    // Also clear the in-memory Map cache in the Avatar module.
    // We dispatch a custom event so Avatar.tsx can listen and clear its Map.
    window.dispatchEvent(new CustomEvent("mailgo:clear-avatar-cache"));
    setSize(0);
    showToast(t("settings.avatarCacheCleared"), "success");
  };

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-geist border px-3 h-10"
      style={{
        borderColor: "var(--geist-border)",
        backgroundColor: "var(--geist-bg-100)",
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: "#f59e0b" }}
        />
        <span className="text-label-12 text-secondary truncate">
          {t("settings.avatarCache", { size: formatBytes(size) })}
        </span>
      </div>
      <Button
        size="small"
        variant="tertiary"
        onClick={clearCache}
        disabled={size === 0}
      >
        {t("settings.clearCache")}
      </Button>
    </div>
  );
}

function StorageSection({
  form,
  patch,
}: {
  form: {
    retention_messages_days: string;
    retention_attachments_days: string;
    retention_images_days: string;
    storage_limit_gb: string;
  };
  patch: (key: keyof typeof form, value: string) => void;
}) {
  const { t } = useTranslation();
  const { data: stats } = useQuery({
    queryKey: ["storage-stats"],
    queryFn: () => storageApi.stats(),
    staleTime: 30_000,
  });

  const total = stats?.total_bytes ?? 0;
  const limit = stats?.limit_bytes ?? 0;

  const msgB = stats?.messages_bytes ?? 0;
  const attB = stats?.attachments_bytes ?? 0;
  const imgB = stats?.images_bytes ?? 0;
  const avatarB = getAvatarCacheSize();
  const allTotal = total + avatarB;
  const sum = msgB + attB + imgB + avatarB || 1;
  const pct = limit > 0 ? Math.min(100, (allTotal / limit) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Usage bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-label-14 font-medium">{t("settings.storageUsage")}</p>
          <span className="text-label-12 text-secondary">
            {stats ? (
              <>
                {formatBytes(allTotal)}
                {limit > 0 ? ` / ${formatBytes(limit)}` : ` ${t("settings.noLimit")}`}
              </>
            ) : t("settings.loadInProgress")}
          </span>
        </div>
        <div
          className="h-3 rounded-full overflow-hidden flex"
          style={{ backgroundColor: "var(--geist-border)" }}
        >
          {stats && allTotal > 0 && (
            <div
              className="h-full flex transition-all duration-500"
              style={{
                width: limit > 0 ? `${pct}%` : "100%",
                maxWidth: "100%",
                background: `linear-gradient(to right,
                  #3b82f6 0%,
                  #3b82f6 ${(msgB / sum) * 100}%,
                  #a855f7 ${(msgB / sum) * 100}%,
                  #a855f7 ${((msgB + attB) / sum) * 100}%,
                  #22c55e ${((msgB + attB) / sum) * 100}%,
                  #22c55e ${((msgB + attB + imgB) / sum) * 100}%,
                  #f59e0b ${((msgB + attB + imgB) / sum) * 100}%,
                  #f59e0b 100%)`,
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-4 mt-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 text-label-11 text-secondary">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#3b82f6" }} />
            {t("settings.emailBody")} {formatBytes(msgB)}
          </span>
          <span className="inline-flex items-center gap-1 text-label-11 text-secondary">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#a855f7" }} />
            {t("settings.attachmentsLabel")} {formatBytes(attB)}
          </span>
          <span className="inline-flex items-center gap-1 text-label-11 text-secondary">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
            {t("settings.images")} {formatBytes(imgB)}
          </span>
          <span className="inline-flex items-center gap-1 text-label-11 text-secondary">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
            {t("settings.avatar")} {formatBytes(avatarB)}
          </span>
        </div>
      </div>

      {/* Individual storage category rows with clear buttons */}
      <StorageRow color="#3b82f6" labelKey="settings.emailBody" bytes={msgB} onClear={async () => {
        await storageApi.clear("messages");
        return true;
      }} />
      <StorageRow color="#a855f7" labelKey="settings.attachmentsLabel" bytes={attB} onClear={async () => {
        await storageApi.clear("attachments");
        return true;
      }} />
      <StorageRow color="#22c55e" labelKey="settings.images" bytes={imgB} onClear={async () => {
        await storageApi.clear("images");
        return true;
      }} />
      <AvatarCacheRow />

      {/* Clear all local data */}
      <div
        className="flex items-center justify-between gap-3 rounded-geist border px-3 h-10"
        style={{
          borderColor: "var(--geist-red-200, var(--geist-border))",
          backgroundColor: "var(--geist-bg-100)",
        }}
      >
        <span className="text-label-12 font-medium" style={{ color: "var(--geist-red-500)" }}>
          {t("settings.clearAllTitle")}
        </span>
        <Button
          size="small"
          variant="tertiary"
          style={{ color: "var(--geist-red-500)" }}
          onClick={async () => {
            const ok = await confirm({
              title: t("settings.clearAllTitle"),
              description: t("settings.clearAllDesc"),
              confirmText: t("settings.clearAllConfirm"),
              confirmVariant: "error",
            });
            if (!ok) return;
            try {
              await storageApi.clear("all");
              showToast(t("settings.clearAllSuccess"), "success");
            } catch {
              showToast(t("settings.clearAllFailed"), "error");
            }
          }}
        >
          {t("settings.clearAll")}
        </Button>
      </div>

      {/* Retention & limit inputs */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-label-13 font-medium mb-1">{t("settings.emailRetentionDays")}</p>
          <p className="text-label-11 text-secondary mb-1">{t("settings.forever")}</p>
          <Input
            inputSize="small"
            type="number"
            min={0}
            value={form.retention_messages_days}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || Number(v) < 0) return;
              patch("retention_messages_days", v);
            }}
          />
        </div>
        <div>
          <p className="text-label-13 font-medium mb-1">{t("settings.attachmentRetentionDays")}</p>
          <p className="text-label-11 text-secondary mb-1">{t("settings.forever")}</p>
          <Input
            inputSize="small"
            type="number"
            min={0}
            value={form.retention_attachments_days}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || Number(v) < 0) return;
              patch("retention_attachments_days", v);
            }}
          />
        </div>
        <div>
          <p className="text-label-13 font-medium mb-1">{t("settings.imageRetentionDays")}</p>
          <p className="text-label-11 text-secondary mb-1">{t("settings.forever")}</p>
          <Input
            inputSize="small"
            type="number"
            min={0}
            value={form.retention_images_days}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || Number(v) < 0) return;
              patch("retention_images_days", v);
            }}
          />
        </div>
        <div>
          <p className="text-label-13 font-medium mb-1">{t("settings.storageLimitGB")}</p>
          <p className="text-label-11 text-secondary mb-1">{t("settings.defaultLimit")}</p>
          <Input
            inputSize="small"
            type="number"
            min={0}
            step={0.1}
            value={form.storage_limit_gb}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || Number(v) < 0) return;
              patch("storage_limit_gb", v);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* --------- Auto-refresh block --------- */
const INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
];

function AutoRefreshSettings({
  form,
  patch,
}: {
  form: {
    auto_refresh_enabled: string;
    check_interval: string;
    notifications_enabled: string;
    autosave_interval: string;
  };
  patch: (key: "auto_refresh_enabled" | "check_interval", value: string) => void;
}) {
  const { t } = useTranslation();
  const { syncNow, phase } = useAutoRefresh({ enableTimer: false });
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);

  const enabled = form.auto_refresh_enabled !== "false";
  const interval = Number(form.check_interval) || 300;

  const isSyncing = phase === "syncing";
  const lastSyncedLabel = formatRelative(lastSyncAt, t);

  // Live countdown to next sync.
  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!enabled || !lastSyncAt) {
      setCountdown("");
      return;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000);
      const remaining = Math.max(0, interval - elapsed);
      if (remaining <= 0) {
        setCountdown(t("sidebar.aboutToSync"));
      } else if (remaining < 60) {
        setCountdown(t("sidebar.secondsUntilSync", { seconds: remaining }));
      } else {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        setCountdown(s > 0 ? t("sidebar.minutesUntilSync", { minutes: m, seconds: s }) : t("sidebar.minutesUntilSyncShort", { minutes: m }));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [enabled, lastSyncAt, interval]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2.5">
          <Zap
            size={16}
            className="mt-0.5 shrink-0"
            style={{ color: "var(--geist-secondary)" }}
          />
          <div>
            <p className="text-label-14 font-medium">
              {t("settings.autoRefresh")}
            </p>
            <p className="text-copy-13 text-secondary mt-0.5">
              {t("settings.autoRefreshHint")}
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onChange={(v) => patch("auto_refresh_enabled", String(v))}
        />
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-4 pl-6 transition-opacity",
          !enabled && "opacity-50 pointer-events-none",
        )}
      >
        <div>
          <label className="text-label-13 text-secondary font-medium">
            {t("settings.checkInterval")}
          </label>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {INTERVAL_PRESETS.map((p) => {
              const active = interval === p.seconds;
              return (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => patch("check_interval", String(p.seconds))}
                  className={cn(
                    "h-7 px-2.5 rounded-geist text-label-12 border transition-colors",
                    active
                      ? "border-[var(--geist-primary)] text-[var(--geist-primary)] font-semibold"
                      : "border-[var(--geist-border)] text-secondary hover:text-[var(--geist-primary)]",
                  )}
                  style={
                    active
                      ? {
                          backgroundColor:
                            "color-mix(in srgb, var(--geist-primary) 10%, transparent)",
                        }
                      : undefined
                  }
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 rounded-geist border px-3 h-10"
          style={{
            borderColor: "var(--geist-border)",
            backgroundColor: "var(--geist-bg-100)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <RotateCw
              size={14}
              className={cn(isSyncing && "spinner shrink-0")}
              style={{ color: "var(--geist-secondary)" }}
            />
            <span className="text-label-12 text-secondary truncate">
              {isSyncing
                ? t("settings.syncing")
                : countdown
                  ? countdown
                  : lastSyncedLabel
                    ? t("settings.lastSynced", { when: lastSyncedLabel })
                    : t("settings.neverSynced")}
            </span>
          </div>
          <Button
            size="small"
            variant="secondary"
            leadingIcon={<RefreshCw size={12} />}
            onClick={() => void syncNow()}
            disabled={isSyncing}
          >
            {t("settings.syncNow")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return t("sidebar.justSynced");
  if (s < 60) return t("sidebar.secondsAgo", { seconds: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("sidebar.minutesAgo", { minutes: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("sidebar.hoursAgo", { hours: h });
  const d = Math.floor(h / 24);
  return t("sidebar.daysAgo", { days: d });
}

/* ============================== Accounts ============================== */
function AccountsSettings() {
  const { t } = useTranslation();
  const { data: accounts = [], isLoading } = useAccountsQuery();
  const del = useDeleteAccount();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showMicrosoftConfig, setShowMicrosoftConfig] = useState(false);
  const syncLock = useSyncStore((s) => s.syncLock);
  const backendSyncing = useSyncStore((s) => s.backendSyncing);
  const syncingAccountIds = useSyncStore((s) => s.syncingAccountIds);
  const isAnySyncing = syncLock || backendSyncing;

  // Per-account sync goes through the same single-flight flow as the
  // global sync button: trigger → 409 means "already running" → poll
  // status until idle → refresh queries.
  const syncAccount = useCallback(
    async (accountId: number) => {
      const store = useSyncStore.getState();
      if (store.syncLock || store.backendSyncing) {
        showToast(t("settings.syncInProgress"), "info");
        return;
      }
      store.beginSync([accountId]);
      try {
        await syncApi.trigger(accountId);
        showToast(t("settings.syncStarted"), "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("already in progress") || msg.includes("409")) {
          showToast(t("settings.syncInProgress"), "info");
        } else {
          useSyncStore.getState().failSync(msg || t("settings.syncFailed"));
          showToast(t("settings.syncFailed"), "error");
        }
      }
    },
    [qc, t],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-heading-20">{t("settings.emailAccounts")}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="small"
            leadingIcon={<LockKeyhole size={14} />}
            onClick={() => setShowMicrosoftConfig(true)}
          >
            {t("settings.microsoftOAuthConfig")}
          </Button>
          <Button
            size="small"
            leadingIcon={<Plus size={14} />}
            onClick={() => setShowAdd(true)}
          >
            {t("settings.addAccount")}
          </Button>
        </div>
      </div>
      {isLoading ? (
        <p className="text-label-13 text-secondary">{t("settings.loadInProgress")}</p>
      ) : accounts.length === 0 ? (
        <div className="card-padded text-center">
          <p className="text-label-14">{t("settings.noAccountsYet")}</p>
          <p className="text-copy-13 text-secondary mt-1">
            {t("settings.addAccount")}
          </p>
        </div>
      ) : (
        <div
          className="rounded-geist border overflow-hidden"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--geist-bg-100)",
                  borderBottom: "1px solid var(--geist-border)",
                }}
              >
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">
                  {t("settings.account")}
                </th>
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">
                  {t("settings.email")}
                </th>
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">
                  {t("settings.marker")}
                </th>
                <th className="text-right text-label-12 text-secondary font-medium px-4 py-2.5">
                  {t("settings.operation")}
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((acc) => (
                <AccountSettingsItem
                  key={acc.id}
                  account={acc}
                  onSync={() => void syncAccount(acc.id)}
                  syncing={syncingAccountIds.has(acc.id)}
                  onDelete={() => del.mutate(acc.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddAccountWizard open={showAdd} onClose={() => setShowAdd(false)} />
      <MicrosoftOAuthSettingsModal
        open={showMicrosoftConfig}
        onClose={() => setShowMicrosoftConfig(false)}
      />
    </div>
  );
}

function MicrosoftOAuthSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const qc = useQueryClient();
  const configuredClientId =
    settings.find((item) => item.key === "microsoft_client_id")?.value || "";
  const secretConfigured =
    settings.find((item) => item.key === "microsoft_client_secret")?.value ===
    "__configured__";
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    if (!open) return;
    setClientId(configuredClientId);
    setClientSecret("");
  }, [configuredClientId, open]);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.update("microsoft_client_id", clientId.trim());
      if (clientSecret) {
        await settingsApi.update(
          "microsoft_client_secret",
          clientSecret.trim(),
        );
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings"] });
      showToast(t("settings.microsoftOAuthSaved"), "success");
      onClose();
    },
    onError: (error) =>
      showToast(
        error instanceof Error
          ? error.message
          : t("settings.microsoftOAuthSaveFailed"),
        "error",
      ),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t("settings.microsoftOAuthConfig")}
      description={t("settings.microsoftOAuthHint")}
      footer={
        <>
          <Button variant="secondary" size="small" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="small"
            loading={save.isPending}
            disabled={
              !clientId.trim() ||
              (!secretConfigured && !clientSecret.trim())
            }
            onClick={() => save.mutate()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="MICROSOFT_CLIENT_ID"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        <Input
          label="MICROSOFT_CLIENT_SECRET"
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder={
            secretConfigured ? t("settings.microsoftSecretConfigured") : ""
          }
          hint={t("settings.microsoftSecretHint")}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-label-12 text-secondary">
            {t("settings.microsoftOAuthStatus")}
          </span>
          <span
            className="text-label-12 font-medium"
            style={{
              color:
                configuredClientId && secretConfigured
                  ? "var(--geist-green-500)"
                  : "var(--geist-secondary)",
            }}
          >
            {configuredClientId && secretConfigured
              ? t("settings.microsoftConfigured")
              : t("settings.microsoftNotConfigured")}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function AccountSettingsItem({
  account,
  onSync,
  syncing,
  onDelete,
}: {
  account: Account;
  onSync: () => void;
  syncing: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateAccount();
  const [editOpen, setEditOpen] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [avatarUrlDraft, setAvatarUrlDraft] = useState("");
  const [form, setForm] = useState({
    name: account.name,
    sender_email: account.sender_email || account.email,
    avatar_url: account.avatar_url || "",
    tag_color: account.tag_color || "",
    sync_days: account.sync_days ?? 0,
    sync_max_messages: account.sync_max_messages ?? 0,
  });

  const save = () => {
    update.mutate({
      id: account.id,
      data: {
        name: form.name,
        email: account.email,
        provider: account.provider,
        imap_host: account.imap_host,
        imap_port: account.imap_port,
        imap_tls: account.imap_tls,
        imap_encryption: account.imap_encryption,
        smtp_host: account.smtp_host,
        smtp_port: account.smtp_port,
        smtp_tls: account.smtp_tls,
        smtp_encryption: account.smtp_encryption,
        username: account.username,
        sender_email: form.sender_email,
        avatar_url: form.avatar_url,
        tag_color: form.tag_color,
        sync_days: form.sync_days,
        sync_max_messages: form.sync_max_messages,
      },
    });
    setEditOpen(false);
  };

  const onUploadAvatar = (file: File) => {
    if (file.size > 512 * 1024) {
      showToast(t("settings.imageTooLarge"), "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({ ...f, avatar_url: reader.result as string }));
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <tr style={{ borderBottom: "1px solid var(--geist-border)" }}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Avatar
              src={form.avatar_url || undefined}
              name={form.name}
              email={account.email}
              tagColor={form.tag_color || undefined}
              size={32}
            />
            <span className="text-label-14 font-semibold truncate">{form.name}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-label-13 text-secondary truncate">{account.email}</td>
        <td className="px-4 py-3">
          {account.tag_color ? (
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ backgroundColor: account.tag_color }}
            />
          ) : (
            <span className="text-label-12 text-secondary">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="small"
              leadingIcon={<RefreshCw size={14} />}
              loading={syncing}
              onClick={onSync}
            >
              {t("settings.syncNow")}
            </Button>
            <Button variant="secondary" size="small" onClick={() => setEditOpen(true)}>
              {t("common.edit")}
            </Button>
            <Button
              variant="error"
              size="small"
              leadingIcon={<Trash2 size={14} />}
              onClick={async () => {
                const ok = await confirm({
                  title: t("settings.deleteAccount"),
                  description: t("settings.deleteAccountDesc", { name: account.name || account.email, email: account.email }),
                  confirmText: t("settings.deleteAccountConfirm"),
                  confirmVariant: "error",
                });
                if (ok) onDelete();
              }}
            >
              {t("common.delete")}
            </Button>
          </div>
        </td>
      </tr>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("common.edit")}
        size="md"
        footer={
          <>
            <Button variant="secondary" size="small" onClick={() => setEditOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="small" onClick={save} loading={update.isPending}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Avatar uploader */}
          <div className="flex items-center gap-4">
            <Avatar
              src={form.avatar_url || undefined}
              name={form.name}
              email={account.email}
              tagColor={form.tag_color || undefined}
              size={56}
            />
            <div className="flex-1">
              <p className="text-label-14 font-medium mb-1">{t("settings.avatarLabel")}</p>
              <p className="text-copy-13 text-secondary mb-2">
                {t("settings.avatarAndColorDesc")}
              </p>
              <div className="flex items-center gap-2">
                <label
                  className="h-8 px-3 inline-flex items-center gap-1.5 rounded-geist border cursor-pointer text-label-13 text-secondary hover:bg-[var(--geist-bg-200)]"
                  style={{ borderColor: "var(--geist-border)" }}
                >
                  <Upload size={13} />
                  {t("settings.uploadAvatar")}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) onUploadAvatar(e.target.files[0]);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
                <button
                  onClick={() => setShowUrlInput((v) => !v)}
                  className="h-8 px-3 inline-flex items-center gap-1.5 rounded-geist border text-label-13 text-secondary hover:bg-[var(--geist-bg-200)]"
                  style={{ borderColor: "var(--geist-border)" }}
                >
                  <Globe size={13} />
                  {t("settings.webImage")}
                </button>
                {form.avatar_url && (
                  <button
                    onClick={() => setForm((f) => ({ ...f, avatar_url: "" }))}
                    className="text-label-12 text-secondary hover:text-[var(--geist-red-500)]"
                  >
                    {t("settings.deleteImage")}
                  </button>
                )}
              </div>
              {showUrlInput && (
                <div className="flex items-center gap-2 mt-2">
                  <input
                    value={avatarUrlDraft}
                    onChange={(e) => setAvatarUrlDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && avatarUrlDraft.trim()) {
                        setForm((f) => ({ ...f, avatar_url: avatarUrlDraft.trim() }));
                        setShowUrlInput(false);
                        setAvatarUrlDraft("");
                      }
                    }}
                    placeholder={t("settings.avatarUrlPlaceholder")}
                    className="input flex-1 h-8 text-[13px]"
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      if (avatarUrlDraft.trim()) {
                        setForm((f) => ({ ...f, avatar_url: avatarUrlDraft.trim() }));
                        setShowUrlInput(false);
                        setAvatarUrlDraft("");
                      }
                    }}
                    className="h-8 px-3 rounded-geist text-label-13 text-white shrink-0"
                    style={{ backgroundColor: "var(--geist-primary)" }}
                  >
                    {t("common.confirm")}
                  </button>
                  <button
                    onClick={() => { setShowUrlInput(false); setAvatarUrlDraft(""); }}
                    className="h-8 px-2 rounded-geist text-label-13 text-secondary hover:bg-[var(--geist-bg-200)] shrink-0"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </div>
          </div>
          <Input
            label={t("settings.wizard.senderName")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            label={t("settings.email")}
            value={form.sender_email}
            onChange={(e) => setForm({ ...form, sender_email: e.target.value })}
          />
          {/* Tag color picker */}
          <div>
            <p className="text-label-14 font-medium mb-1.5">{t("settings.markerColor")}</p>
            <p className="text-copy-13 text-secondary mb-2">
              {t("settings.avatarAndColorDesc")}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {[
                "#006bff", "#a000f8", "#28a948", "#f22782",
                "#ffae00", "#00ac96", "#e00", "#666",
              ].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      tag_color: f.tag_color === c ? "" : c,
                    }))
                  }
                  className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor:
                      form.tag_color === c
                        ? "var(--geist-primary)"
                        : "transparent",
                  }}
                />
              ))}
              {form.tag_color && (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, tag_color: "" }))}
                  className="text-label-12 text-secondary hover:text-[var(--geist-red-500)] ml-1"
                >
                  {t("settings.clearColor")}
                </button>
              )}
            </div>
          </div>
          {/* Sync days */}
          <div>
            <label className="text-label-14 font-medium mb-1 block">
              {t("settings.syncDays")}
            </label>
            <p className="text-copy-13 text-secondary mb-1.5">
              {t("settings.syncDaysHint")}
            </p>
            <input
              type="number"
              min={0}
              max={3650}
              value={form.sync_days}
              onChange={(e) => {
                const v = Math.max(0, Math.min(3650, Number(e.target.value) || 0));
                setForm((f) => ({ ...f, sync_days: v }));
              }}
              placeholder={t("settings.syncDaysPlaceholder")}
              className="input-small w-full max-w-[200px]"
            />
          </div>
          <div>
            <label className="text-label-14 font-medium mb-1 block">
              {t("settings.syncMaxMessages")}
            </label>
            <p className="text-copy-13 text-secondary mb-1.5">
              {t("settings.syncMaxMessagesHint")}
            </p>
            <input
              type="number"
              min={0}
              max={100000}
              value={form.sync_max_messages}
              onChange={(e) => {
                const v = Math.max(0, Math.min(100000, Number(e.target.value) || 0));
                setForm((f) => ({ ...f, sync_max_messages: v }));
              }}
              placeholder={t("settings.syncMaxMessagesPlaceholder")}
              className="input-small w-full max-w-[200px]"
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ============================== Appearance ============================== */
function AppearanceSettings() {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const qc = useQueryClient();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const showUnread = useAppStore((s) => s.showFolderUnreadCount);
  const setShowUnread = useAppStore((s) => s.setShowFolderUnreadCount);
  const conversationView = useAppStore((s) => s.conversationViewEnabled);
  const setConversationView = useAppStore((s) => s.setConversationViewEnabled);
  const autoLoadRemoteResources =
    settings.find((s) => s.key === "auto_load_remote_resources")?.value === "true";
  const preventTracking =
    settings.find((s) => s.key === "prevent_tracking")?.value !== "false";
  const customCssFromSettings = settings.find((s) => s.key === "custom_css")?.value || "";
  const [customCss, setCustomCss] = useState(customCssFromSettings);

  // Sync local state when settings load/change externally.
  useEffect(() => {
    setCustomCss(customCssFromSettings);
  }, [customCssFromSettings]);
  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      settingsApi.update(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  // Appearance store (cloud-synced).
  const appearance = useAppearanceStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);

  // Cleanup debounce timer on unmount.
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const patchAppearance = (partial: Partial<AppearanceSettingsType>) => {
    appearance.patch(partial);
    editingRef.current = true;
    markAppearanceEditing();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Read fresh state from store to avoid stale closure.
      const current = useAppearanceStore.getState();
      const { patch: _, replaceAll: __, ...clean } = current as any;
      updateSetting.mutate({ key: "appearance", value: JSON.stringify(clean) }, {
        onSettled: () => { editingRef.current = false; },
      });
    }, 500);
  };

  const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("settings.themeLight"), icon: Sun },
    { value: "dark", label: t("settings.themeDark"), icon: Moon },
    { value: "system", label: t("settings.themeSystem"), icon: Monitor },
  ];

  const ACCENT_PRESETS = [
    "#006bff", "#0ea5e9", "#06b6d4", "#10b981",
    "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e",
    "#f97316", "#eab308", "#6366f1", "#171717",
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-20">{t("settings.appearance")}</h2>
        <span className="text-label-12 flex items-center gap-1.5" style={{ color: "var(--geist-tertiary)" }}>
          {updateSetting.isPending ? (
            <>{t("settings.saving")}</>
          ) : updateSetting.isSuccess ? (
            <><Check size={12} /> {t("settings.autoSaved")}</>
          ) : null}
        </span>
      </div>

      {/* ── Theme ── */}
      <div className="card-padded space-y-4">
        <div>
          <p className="text-label-14 font-medium mb-3">{t("settings.theme")}</p>
          <div className="grid grid-cols-3 gap-3">
            {themeOptions.map((o) => {
              const Icon = o.icon;
              const active = theme === o.value;
              return (
                <button key={o.value} onClick={() => setTheme(o.value)}
                  className={cn("h-20 rounded-geist flex flex-col items-center justify-center gap-1.5 border-2 transition-colors",
                    active ? "border-[var(--geist-primary)] bg-[var(--geist-bg-200)]" : "border-[var(--geist-border)] hover:border-[var(--geist-gray-400)]")}>
                  <Icon size={20} style={{ color: "var(--geist-primary)" }} />
                  <span className="text-label-13">{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Accent Color ── */}
      <div className="card-padded space-y-4">
        <div className="flex items-center gap-2.5">
          <Palette size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.accentColor")}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_PRESETS.map((color) => (
            <button key={color} onClick={() => patchAppearance({ accent_color: color })}
              className={cn("w-8 h-8 rounded-full border-2 transition-all hover:scale-110",
                appearance.accent_color === color ? "border-[var(--geist-primary)] scale-110 shadow-md" : "border-transparent")}
              style={{ backgroundColor: color }} title={color} />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-label-13 text-secondary">{t("settings.customColor")}</label>
          <input type="color" value={appearance.accent_color}
            onChange={(e) => patchAppearance({ accent_color: e.target.value })}
            className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent" />
          <Input value={appearance.accent_color}
            onChange={(e) => patchAppearance({ accent_color: e.target.value })}
            className="w-28 font-mono text-label-13" maxLength={7} />
        </div>
        <SliderSetting label={t("settings.accentSaturation")} value={appearance.accent_saturation} min={0} max={100} step={5} unit="%" onChange={(v) => patchAppearance({ accent_saturation: v })} />
      </div>

      {/* ── Glassmorphism ── */}
      <div className="card-padded space-y-5">
        <div className="flex items-center gap-2.5">
          <Layers size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.glassmorphism")}</p>
        </div>
        <SliderSetting label={t("settings.sidebarBlur")} hint={t("settings.sidebarBlurHint")} value={appearance.sidebar_blur} min={0} max={20} step={1} unit="px" onChange={(v) => patchAppearance({ sidebar_blur: v })} />
        <SliderSetting label={t("settings.sidebarOpacity")} hint={t("settings.sidebarOpacityHint")} value={appearance.sidebar_opacity} min={0} max={100} step={5} unit="%" onChange={(v) => patchAppearance({ sidebar_opacity: v })} />
        <SliderSetting label={t("settings.contentBlur")} hint={t("settings.contentBlurHint")} value={appearance.bg_blur} min={0} max={20} step={1} unit="px" onChange={(v) => patchAppearance({ bg_blur: v })} />
      </div>

      {/* ── Background Image ── */}
      <div className="card-padded space-y-4">
        <div className="flex items-center gap-2.5">
          <ImageIcon size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.backgroundImage")}</p>
        </div>
        <p className="text-copy-13 text-secondary">{t("settings.backgroundImageDesc")}</p>

        {/* Desktop */}
        <div className="space-y-2">
          <p className="text-label-13 font-medium">{t("settings.bgImageDesktop")}</p>
          <div className="flex items-center gap-3">
            <label className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-geist border text-label-12 cursor-pointer hover:bg-[var(--geist-bg-200)] transition-colors"
              style={{ borderColor: "var(--geist-border)" }}>
              <Upload size={13} />
              {t("settings.uploadBackground")}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => patchAppearance({ bg_image: reader.result as string });
                reader.readAsDataURL(file);
                e.currentTarget.value = "";
              }} />
            </label>
            {appearance.bg_image && (
              <button onClick={() => patchAppearance({ bg_image: "" })}
                className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-geist border text-label-12 hover:bg-[var(--geist-bg-200)] transition-colors"
                style={{ borderColor: "var(--geist-border)", color: "var(--geist-red-500)" }}>
                <Trash2 size={13} /> {t("settings.clearBackground")}
              </button>
            )}
          </div>
          {appearance.bg_image && (
            <div className="w-full max-w-[280px] rounded-geist overflow-hidden border" style={{ borderColor: "var(--geist-border)" }}>
              <img src={appearance.bg_image} alt="Desktop background preview" className="w-full h-28 object-cover" />
            </div>
          )}
        </div>

        {/* Mobile */}
        <div className="space-y-2">
          <p className="text-label-13 font-medium">{t("settings.bgImageMobile")}</p>
          <div className="flex items-center gap-3">
            <label className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-geist border text-label-12 cursor-pointer hover:bg-[var(--geist-bg-200)] transition-colors"
              style={{ borderColor: "var(--geist-border)" }}>
              <Upload size={13} />
              {t("settings.uploadBackground")}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => patchAppearance({ bg_image_mobile: reader.result as string });
                reader.readAsDataURL(file);
                e.currentTarget.value = "";
              }} />
            </label>
            {appearance.bg_image_mobile && (
              <button onClick={() => patchAppearance({ bg_image_mobile: "" })}
                className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-geist border text-label-12 hover:bg-[var(--geist-bg-200)] transition-colors"
                style={{ borderColor: "var(--geist-border)", color: "var(--geist-red-500)" }}>
                <Trash2 size={13} /> {t("settings.clearBackground")}
              </button>
            )}
          </div>
          {appearance.bg_image_mobile && (
            <div className="w-full max-w-[160px] rounded-geist overflow-hidden border" style={{ borderColor: "var(--geist-border)" }}>
              <img src={appearance.bg_image_mobile} alt="Mobile background preview" className="w-full h-36 object-cover" />
            </div>
          )}
        </div>

        {(appearance.bg_image || appearance.bg_image_mobile) && (
          <SliderSetting label={t("settings.bgOpacity")} hint={t("settings.bgOpacityDesc")} value={appearance.bg_opacity} min={0} max={100} step={5} unit="%" onChange={(v) => patchAppearance({ bg_opacity: v })} />
        )}
      </div>

      {/* ── Text Color ── */}
      <div className="card-padded space-y-4">
        <div className="flex items-center gap-2.5">
          <Type size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.textColor")}</p>
        </div>
        <p className="text-copy-13 text-secondary">{t("settings.textColorDesc")}</p>
        {[
          { key: "text_color_light" as const, label: t("settings.textColorLight"), default: "#171717" },
          { key: "text_color_dark" as const, label: t("settings.textColorDark"), default: "#ededed" },
        ].map(({ key, label, default: defaultColor }) => {
          const current = appearance[key] || "";
          return (
            <div key={key} className="flex items-center gap-3">
              <span className="text-label-13 text-secondary w-20 shrink-0">{label}</span>
              <input type="color" value={current || defaultColor}
                onChange={(e) => patchAppearance({ [key]: e.target.value })}
                className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent" />
              <Input value={current} placeholder={defaultColor}
                onChange={(e) => patchAppearance({ [key]: e.target.value })}
                className="w-28 font-mono text-label-13" maxLength={7} />
              {current && (
                <button onClick={() => patchAppearance({ [key]: "" })}
                  className="text-label-12 shrink-0" style={{ color: "var(--geist-tertiary)" }}>
                  {t("settings.textColorReset")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Layout ── */}
      <div className="card-padded space-y-5">
        <div className="flex items-center gap-2.5">
          <SlidersHorizontal size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.layout")}</p>
        </div>
        <SliderSetting label={t("settings.borderRadius")} value={appearance.border_radius} min={0} max={16} step={1} unit="px" onChange={(v) => patchAppearance({ border_radius: v })} />
        <div className="flex items-center justify-between gap-4">
          <span className="text-label-14">{t("settings.fontSize")}</span>
          <div className="flex gap-2">
            {(["sm", "md", "lg"] as const).map((size) => {
              const labels = { sm: t("settings.fontSizeSmall"), md: t("settings.fontSizeMedium"), lg: t("settings.fontSizeLarge") };
              const px = { sm: "13px", md: "14px", lg: "16px" };
              return (
                <button key={size} onClick={() => patchAppearance({ font_size: size })}
                  className={cn("px-3 py-1.5 rounded-geist text-label-13 border transition-colors",
                    appearance.font_size === size
                      ? "border-[var(--geist-tertiary)] text-[var(--geist-tertiary)] bg-[var(--mailgo-accent-light)]"
                      : "border-[var(--geist-border)] text-secondary hover:border-[var(--geist-gray-400)]")}>
                  {labels[size]} ({px[size]})
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-label-14">{t("settings.compactMode")}</p>
            <p className="text-copy-13 text-secondary mt-0.5">{t("settings.compactModeHint")}</p>
          </div>
          <Switch checked={appearance.compact_mode} onChange={(v) => patchAppearance({ compact_mode: v })} />
        </div>
      </div>

      {/* ── Visual Effects ── */}
      <div className="card-padded space-y-5">
        <div className="flex items-center gap-2.5">
          <Sparkles size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.visualEffects")}</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-label-14">{t("settings.shadowIntensity")}</span>
          <div className="flex gap-2">
            {(["none", "sm", "md", "lg"] as const).map((level) => {
              const labels = { none: t("settings.shadowNone"), sm: t("settings.shadowLight"), md: t("settings.shadowMedium"), lg: t("settings.shadowHeavy") };
              return (
                <button key={level} onClick={() => patchAppearance({ shadow_intensity: level })}
                  className={cn("px-3 py-1.5 rounded-geist text-label-13 border transition-colors",
                    appearance.shadow_intensity === level
                      ? "border-[var(--geist-tertiary)] text-[var(--geist-tertiary)] bg-[var(--mailgo-accent-light)]"
                      : "border-[var(--geist-border)] text-secondary hover:border-[var(--geist-gray-400)]")}>
                  {labels[level]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-label-14">{t("settings.animationSpeed")}</span>
          <div className="flex gap-2">
            {(["off", "slow", "normal", "fast"] as const).map((speed) => {
              const labels = { off: t("settings.animOff"), slow: t("settings.animSlow"), normal: t("settings.animNormal"), fast: t("settings.animFast") };
              return (
                <button key={speed} onClick={() => patchAppearance({ animation_speed: speed })}
                  className={cn("px-3 py-1.5 rounded-geist text-label-13 border transition-colors",
                    appearance.animation_speed === speed
                      ? "border-[var(--geist-tertiary)] text-[var(--geist-tertiary)] bg-[var(--mailgo-accent-light)]"
                      : "border-[var(--geist-border)] text-secondary hover:border-[var(--geist-gray-400)]")}>
                  {labels[speed]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Existing toggles ── */}
      <div className="card-padded space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <MailOpen size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
            <div>
              <p className="text-label-14 font-medium">{t("settings.showUnreadCounts")}</p>
              <p className="text-copy-13 text-secondary mt-0.5">{t("settings.showUnreadCountsHint")}</p>
            </div>
          </div>
          <Switch checked={showUnread} onChange={setShowUnread} />
        </div>
        <div className="divider" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <MessagesSquare size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
            <div>
              <p className="text-label-14 font-medium">{t("settings.conversationView")}</p>
              <p className="text-copy-13 text-secondary mt-0.5">{t("settings.conversationViewHint")}</p>
            </div>
          </div>
          <Switch checked={conversationView} onChange={setConversationView} />
        </div>
        <div className="divider" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Eye size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
            <div>
              <p className="text-label-14 font-medium">{t("settings.defaultLoadRemote")}</p>
              <p className="text-copy-13 text-secondary mt-0.5">{t("settings.defaultLoadRemoteHint")}</p>            </div>
          </div>
          <Switch checked={autoLoadRemoteResources}
            onChange={(checked) => updateSetting.mutate({ key: "auto_load_remote_resources", value: checked ? "true" : "false" })} />
        </div>
        <div className="divider" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Shield size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
            <div>
              <p className="text-label-14 font-medium">{t("settings.preventTracking")}</p>
              <p className="text-copy-13 text-secondary mt-0.5">{t("settings.preventTrackingHint")}</p>
            </div>
          </div>
          <Switch checked={preventTracking}
            onChange={(checked) => updateSetting.mutate({ key: "prevent_tracking", value: checked ? "true" : "false" })} />
        </div>
      </div>

      {/* ── Custom CSS Injection ── */}
      <div className="card-padded space-y-3">
        <div className="flex items-center gap-2.5">
          <Code2 size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("settings.customCss")}</p>
        </div>
        <p className="text-copy-13 text-secondary">{t("settings.customCssDesc")}</p>
        <textarea
          value={customCss}
          onChange={(e) => setCustomCss(e.target.value)}
          onBlur={() => {
            if (customCss !== customCssFromSettings) {
              updateSetting.mutate({ key: "custom_css", value: customCss });
            }
          }}
          placeholder={t("settings.customCssPlaceholder")}
          className="w-full font-mono text-label-13 rounded-geist border px-3 py-2.5 resize-y min-h-[120px] max-h-[400px] outline-none focus:border-[var(--geist-primary)] transition-colors"
          style={{
            borderColor: "var(--geist-border)",
            backgroundColor: "var(--geist-bg-100)",
            color: "var(--geist-primary)",
          }}
          spellCheck={false}
        />
      </div>

      {/* ── Reset to defaults ── */}
      <div className="card-padded flex items-center justify-between gap-4">
        <div>
          <p className="text-label-14 font-medium">{t("settings.resetAppearance")}</p>
          <p className="text-copy-13 text-secondary mt-0.5">{t("settings.resetAppearanceDesc")}</p>
        </div>
        <Button variant="secondary" size="small"
          onClick={() => {
            patchAppearance({
              accent_color: "#006bff",
              accent_saturation: 100,
              sidebar_blur: 0,
              sidebar_opacity: 100,
              bg_blur: 0,
              border_radius: 6,
              font_size: "md",
              compact_mode: false,
              shadow_intensity: "md",
              animation_speed: "normal",
              bg_image: "",
              bg_image_mobile: "",
              bg_opacity: 100,
              text_color_light: "",
              text_color_dark: "",
            });
            showToast(t("settings.saved"), "success");
          }}>
          {t("settings.resetAppearance")}
        </Button>
      </div>
    </div>
  );
}

/* ── Reusable slider row ── */
function SliderSetting({ label, hint, value, min, max, step, unit, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-label-14 shrink-0">{label}</span>
        {hint && <p className="text-copy-12 text-secondary mt-0.5">{hint}</p>}
      </div>
      <div className="flex items-center gap-3 flex-1 max-w-[260px]">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
          style={{ background: `linear-gradient(to right, var(--geist-tertiary) ${pct}%, var(--geist-gray-300) ${pct}%)` }} />
        <span className="text-label-13 text-secondary tabular-nums w-12 text-right">{value}{unit}</span>
      </div>
    </div>
  );
}

/* ============================== AI ============================== */
function AISettings() {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    ai_base_url: "",
    ai_api_key: "",
    ai_model: "",
    ai_context_window: "0",
    ai_system_prompt: "",
    ai_translate_use_global: "true",
    ai_translate_base_url: "",
    ai_translate_api_key: "",
    ai_translate_model: "",
  });
  const [dirty, setDirty] = useState(false);

  // Sync settings → local form (only when settings load / change externally).
  useEffect(() => {
    const get = (k: string) => settings.find((s) => s.key === k)?.value || "";
    setForm({
      ai_base_url: get("ai_base_url"),
      ai_api_key: "",
      ai_model: get("ai_model"),
      ai_context_window: get("ai_context_window") || "0",
      ai_system_prompt: get("ai_system_prompt"),
      ai_translate_use_global: get("ai_translate_use_global") || "true",
      ai_translate_base_url: get("ai_translate_base_url"),
      ai_translate_api_key: "",
      ai_translate_model: get("ai_translate_model"),
    });
    setDirty(false);
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(form).filter(
        ([key, value]) =>
          // Skip empty password fields (preserve existing value).
          (!key.endsWith("_api_key")) ||
          (value.trim() !== "" && value !== "__configured__"),
      );
      await Promise.all(entries.map(([key, value]) => settingsApi.update(key, value)));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      showToast(t("settings.saved"), "success");
      setDirty(false);
    },
  });

  const patch = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const translateUseGlobal = form.ai_translate_use_global === "true";

  return (
    <div className="space-y-6">
      {/* ---- Global AI Agent ---- */}
      <div>
        <h2 className="text-heading-20">{t("settings.ai")}</h2>
        <p className="text-copy-13 text-secondary mt-1">
          {t("settings.aiAgentHint")}
        </p>
      </div>
      <div className="card-padded space-y-4">
        <Input
          label={t("settings.aiBaseUrl")}
          value={form.ai_base_url}
          onChange={(e) => patch("ai_base_url", e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
        <Input
          label={t("settings.aiApiKey")}
          type="password"
          value={form.ai_api_key}
          onChange={(e) => patch("ai_api_key", e.target.value)}
          placeholder={
            settings.find((s) => s.key === "ai_api_key")?.value === "__configured__"
              ? t("settings.apiKeyConfigured")
              : "sk-..."
          }
        />
        <Input
          label={t("settings.aiModel")}
          value={form.ai_model}
          onChange={(e) => patch("ai_model", e.target.value)}
          placeholder="gpt-4o-mini"
        />
        <Input
          label={t("settings.contextWindow")}
          type="number"
          min={0}
          value={form.ai_context_window}
          onChange={(e) => patch("ai_context_window", e.target.value)}
          placeholder={t("settings.contextWindowPlaceholder")}
          hint={t("settings.contextWindowHint")}
        />
        <div className="space-y-1.5">
          <label className="text-label-14 font-medium" style={{ color: "var(--geist-primary)" }}>
            {t("settings.aiSystemPrompt")}
          </label>
          <p className="text-copy-13 text-secondary">{t("settings.aiSystemPromptHint")}</p>
          <textarea
            value={form.ai_system_prompt}
            onChange={(e) => patch("ai_system_prompt", e.target.value)}
            placeholder={t("settings.aiSystemPromptHint")}
            className="w-full font-mono text-label-13 rounded-geist border px-3 py-2.5 resize-y min-h-[120px] max-h-[400px] outline-none focus:border-[var(--geist-primary)] transition-colors"
            style={{
              borderColor: "var(--geist-border)",
              backgroundColor: "var(--geist-bg-100)",
              color: "var(--geist-primary)",
            }}
          />
        </div>
      </div>

      {/* ---- Translation AI ---- */}
      <div className="card-padded space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={translateUseGlobal}
            onChange={(e) =>
              patch("ai_translate_use_global", e.target.checked ? "true" : "false")
            }
            className="mt-0.5 h-4 w-4 rounded accent-[var(--geist-primary)] shrink-0"
          />
          <div className="min-w-0">
            <span
              className="text-label-14 font-medium block"
              style={{ color: "var(--geist-primary)" }}
            >
              {t("settings.aiTranslateUseGlobal")}
            </span>
            <span className="text-copy-13 text-secondary mt-0.5 block">
              {t("settings.aiTranslateUseGlobalHint")}
            </span>
          </div>
        </label>

        {!translateUseGlobal && (
          <>
            <Input
              label={t("settings.aiTranslateBaseUrl")}
              value={form.ai_translate_base_url}
              onChange={(e) => patch("ai_translate_base_url", e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
            <Input
              label={t("settings.aiTranslateApiKey")}
              type="password"
              value={form.ai_translate_api_key}
              onChange={(e) => patch("ai_translate_api_key", e.target.value)}
              placeholder={
                settings.find((s) => s.key === "ai_translate_api_key")?.value === "__configured__"
                  ? t("settings.apiKeyConfigured")
                  : "sk-..."
              }
            />
            <Input
              label={t("settings.aiTranslateModel")}
              value={form.ai_translate_model}
              onChange={(e) => patch("ai_translate_model", e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          size="small"
          loading={save.isPending}
          disabled={!dirty}
          onClick={() => save.mutate()}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/* ============================== Security ============================== */
function SecuritySettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: keys = [], isLoading } = useQuery({
    queryKey: ["pgp-keys"],
    queryFn: () => pgpKeysApi.list(),
    staleTime: 30_000,
  });
  const deleteKey = useMutation({
    mutationFn: (id: number) => pgpKeysApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pgp-keys"] });
      showToast(t("pgp.keyDeleted"), "success");
    },
  });
  const [showAdd, setShowAdd] = useState(false);

  // Password change state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState("");
  const changePw = useMutation({
    mutationFn: () => authApi.changePassword(currentPw, newPw),
    onSuccess: () => {
      showToast(t("login.passwordChanged"), "success");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setPwError("");
    },
    onError: () => {
      setPwError(t("login.passwordChangeFailed"));
    },
  });

  const handlePasswordChange = () => {
    setPwError("");
    if (newPw.length < 6) {
      setPwError(t("login.passwordTooShort"));
      return;
    }
    if (newPw !== confirmPw) {
      setPwError(t("login.passwordMismatch"));
      return;
    }
    changePw.mutate();
  };

  return (
    <div className="space-y-6">
      {/* ── Change Password ── */}
      <div className="card-padded space-y-4">
        <div className="flex items-center gap-2.5">
          <LockKeyhole size={16} style={{ color: "var(--geist-secondary)" }} />
          <p className="text-label-14 font-medium">{t("login.changePassword")}</p>
        </div>
        <Input
          label={t("login.currentPassword")}
          type="password"
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
          autoComplete="current-password"
        />
        <Input
          label={t("login.newPassword")}
          type="password"
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          autoComplete="new-password"
        />
        <Input
          label={t("login.confirmPassword")}
          type="password"
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          autoComplete="new-password"
        />
        {pwError && (
          <p className="text-label-12" style={{ color: "var(--geist-red-500)" }}>{pwError}</p>
        )}
        <Button
          size="small"
          onClick={handlePasswordChange}
          loading={changePw.isPending}
          disabled={!currentPw || !newPw || !confirmPw}
        >
          {t("login.changePassword")}
        </Button>
      </div>

      {/* ── PGP Keys ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-heading-20">{t("pgp.newKey")}</h2>
        <Button
          size="small"
          leadingIcon={<Plus size={14} />}
          onClick={() => setShowAdd(true)}
        >
          {t("pgp.newKey")}
        </Button>
      </div>
      <p className="text-copy-13 text-secondary">
        {t("pgp.privateKeyHint")}
      </p>
      {isLoading ? (
        <p className="text-label-13 text-secondary">{t("settings.loadInProgress")}</p>
      ) : keys.length === 0 ? (
        <div className="card-padded text-center">
          <Shield size={28} className="mx-auto mb-2" style={{ color: "var(--geist-tertiary)" }} />
          <p className="text-label-14">{t("pgp.noKeys")}</p>
          <p className="text-copy-13 text-secondary mt-1">
            {t("pgp.nameAndPubRequired")}
          </p>
        </div>
      ) : (
        <div
          className="rounded-geist border overflow-hidden"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--geist-bg-100)",
                  borderBottom: "1px solid var(--geist-border)",
                }}
              >
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">{t("pgp.name")}</th>
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">{t("pgp.fingerprint")}</th>
                <th className="text-left text-label-12 text-secondary font-medium px-4 py-2.5">{t("pgp.createdAt")}</th>
                <th className="text-right text-label-12 text-secondary font-medium px-4 py-2.5">{t("pgp.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <PGPKeyRow key={k.id} keyData={k} onDelete={() => deleteKey.mutate(k.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddPGPKeyModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}

function PGPKeyRow({
  keyData,
  onDelete,
}: {
  keyData: { id: number; name: string; public_key: string; created_at: string };
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    void getKeyFingerprint(keyData.public_key).then(setFingerprint);
  }, [keyData.public_key]);

  return (
    <tr style={{ borderBottom: "1px solid var(--geist-border)" }}>
      <td className="px-4 py-3 text-label-14 font-semibold">{keyData.name}</td>
      <td className="px-4 py-3 text-label-12 text-secondary font-mono">
        {fingerprint ? fingerprint.slice(0, 20) + "…" : "—"}
      </td>
      <td className="px-4 py-3 text-label-12 text-secondary">
        {new Date(keyData.created_at).toLocaleDateString()}
      </td>
      <td className="px-4 py-3 text-right">
        <Button variant="error" size="small" leadingIcon={<Trash2 size={14} />} onClick={onDelete}>
          {t("common.delete")}
        </Button>
      </td>
    </tr>
  );
}

function AddPGPKeyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (data: { name: string; public_key: string; private_key: string }) =>
      pgpKeysApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pgp-keys"] });
      showToast(t("pgp.keySaved"), "success");
      onClose();
    },
    onError: () => showToast(t("pgp.keySaveFailed"), "error"),
  });
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [generating, setGenerating] = useState(false);
  const [mode, setMode] = useState<"import" | "generate">("import");
  const [email, setEmail] = useState("");

  const downloadKey = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "application/pgp-keys" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleGenerate = async () => {
    if (!name.trim()) {
      showToast(t("pgp.nameRequired"), "warning");
      return;
    }
    setGenerating(true);
    try {
      const kp = await generateKeyPair(name.trim(), email || "user@mailgo");
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      showToast(t("pgp.keyGenerated"), "success");
    } catch {
      showToast(t("pgp.keySaveFailed"), "error");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = () => {
    if (!name.trim() || !publicKey.trim()) {
      showToast(t("pgp.nameAndPubRequired"), "warning");
      return;
    }
    create.mutate({ name: name.trim(), public_key: publicKey.trim(), private_key: privateKey.trim() });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("pgp.newKey")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="small" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="small" onClick={handleSave} loading={create.isPending}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button
            variant={mode === "import" ? "primary" : "secondary"}
            size="small"
            onClick={() => setMode("import")}
          >
            {t("pgp.importKey")}
          </Button>
          <Button
            variant={mode === "generate" ? "primary" : "secondary"}
            size="small"
            onClick={() => setMode("generate")}
          >
            {t("pgp.generate")}
          </Button>
        </div>
        <Input
          label={t("pgp.keyName")}
          value={name}
          placeholder={t("pgp.keyNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
        {mode === "generate" && (
          <>
            <Input
              label={t("pgp.associatedEmail")}
              value={email}
              placeholder="user@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              variant="secondary"
              size="small"
              loading={generating}
              onClick={handleGenerate}
            >
              {t("pgp.generateRSA")}
            </Button>
            {publicKey && privateKey && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => downloadKey(publicKey, `${name || "key"}_public.asc`)}
                >
                  <Download size={14} />
                  {t("pgp.downloadPublicKey")}
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => downloadKey(privateKey, `${name || "key"}_private.asc`)}
                >
                  <Download size={14} />
                  {t("pgp.downloadPrivateKey")}
                </Button>
              </div>
            )}
          </>
        )}
        <Textarea
          label={t("pgp.publicKey")}
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
          rows={5}
        />
        <Textarea
          label={t("pgp.privateKey")}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
          rows={5}
          hint={t("pgp.privateKeyHint")}
        />
      </div>
    </Modal>
  );
}

/* ============================== About ============================== */
function AboutSettings() {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    [t("settings.application"), "MailGo"],
    [t("settings.version"), "0.2.0"],
    [t("settings.backend"), "Go + SQLite (WAL)"],
    [t("settings.frontend"), "React 19 + TypeScript + TailwindCSS"],
    [t("settings.license"), "Apache-2.0"],
  ];
  return (
    <div className="space-y-6">
      <h2 className="text-heading-20">{t("settings.about")}</h2>
      <div className="card-padded space-y-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between">
            <span className="text-label-14 text-secondary">{k}</span>
            <span className="text-label-14 font-medium">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
