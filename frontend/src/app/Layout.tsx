import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Sidebar } from "@/components/layout/Sidebar";
import { InboxView } from "@/features/inbox/InboxView";
import { MailFolderView } from "@/components/message/MailFolderView";
import { StarredView } from "@/features/starred/StarredView";
import { DraftsView } from "@/features/drafts/DraftsView";
import { SearchView } from "@/features/search/SearchView";
import { SettingsView } from "@/features/settings/SettingsView";
import { ComposeView } from "@/features/compose/ComposeView";
import { AIAssistantView } from "@/features/ai/AIAssistantView";
import { CommandPalette } from "@/components/CommandPalette";
import { ToastContainer } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ContextMenuProvider } from "@/components/ui/ContextMenu";
import { AIMiniChatHost } from "@/components/ai/AIMiniChatHost";
import { useAppStore, initThemeFromStorage } from "@/stores/appStore";
import {
  initAppearanceFromStorage,
  syncAppearanceFromBackend,
  reapplyAppearanceForTheme,
  isAppearanceEditing,
} from "@/stores/appearanceStore";
import { type AppearanceSettings, DEFAULT_APPEARANCE } from "@/lib/api";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { useHeartbeat } from "@/hooks/useHeartbeat";
import { useUrlSync } from "@/hooks/useUrlSync";
import { useIsMobile, useIsMobileOrTablet } from "@/hooks/useBreakpoint";
import { cn, setAppTimeZone } from "@/lib/utils";
import { Loader2, RefreshCw, AlertTriangle, WifiOff, Menu, Inbox, Search, Bot, Settings as SettingsIcon, PenSquare } from "lucide-react";

initThemeFromStorage();
initAppearanceFromStorage();

export default function Layout() {
  const { t } = useTranslation();
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const openCompose = useAppStore((s) => s.openCompose);
  const closeCompose = useAppStore((s) => s.closeCompose);
  const togglePalette = useAppStore((s) => s.togglePalette);
  const networkStatus = useAppStore((s) => s.networkStatus);
  const setNetworkStatus = useAppStore((s) => s.setNetworkStatus);
  const setMobileSidebarOpen = useAppStore((s) => s.setMobileSidebarOpen);
  const isMobile = useIsMobile();
  const isMobileOrTablet = useIsMobileOrTablet();
  const [systemOnline, setSystemOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const heartbeatOk = useHeartbeat();
  useUrlSync();

  // Sync appearance settings from backend.
  const { data: settings } = useSettingsQuery();
  useEffect(() => {
    if (!settings) return;
    // Skip if user is actively editing appearance (debounce in progress).
    if (isAppearanceEditing()) return;
    const raw = settings.find((s) => s.key === "appearance")?.value;
    if (!raw) return;
    try {
      const parsed: AppearanceSettings = JSON.parse(raw);
      syncAppearanceFromBackend({ ...DEFAULT_APPEARANCE, ...parsed });
    } catch {
      /* ignore malformed JSON */
    }
  }, [settings]);

  // Inject custom CSS from settings.
  useEffect(() => {
    if (!settings) return;
    const css = settings.find((s) => s.key === "custom_css")?.value || "";
    let el = document.getElementById("mailgo-custom-css") as HTMLStyleElement | null;
    if (css) {
      if (!el) {
        el = document.createElement("style");
        el.id = "mailgo-custom-css";
        document.head.appendChild(el);
      }
      el.textContent = css;
    } else if (el) {
      el.remove();
    }
  }, [settings]);

  // Sync theme from backend (cross-device persistence).
  const applyThemeFromBackend = useAppStore((s) => s.applyThemeFromBackend);
  useEffect(() => {
    if (!settings) return;
    const backendTheme = settings.find((s) => s.key === "theme")?.value;
    if (backendTheme && (backendTheme === "light" || backendTheme === "dark" || backendTheme === "system")) {
      const localTheme = useAppStore.getState().theme;
      if (backendTheme !== localTheme) {
        applyThemeFromBackend(backendTheme as "light" | "dark" | "system");
      }
    }
  }, [settings, applyThemeFromBackend]);

  // Sync language from backend (cross-device persistence).
  useEffect(() => {
    if (!settings) return;
    const backendLang = settings.find((s) => s.key === "language")?.value;
    if (backendLang && (backendLang === "zh-CN" || backendLang === "en")) {
      const localLang = localStorage.getItem("mailgo-language") || "zh-CN";
      if (backendLang !== localLang) {
        i18next.changeLanguage(backendLang);
        localStorage.setItem("mailgo-language", backendLang);
      }
    }
  }, [settings]);

  // Sync timezone from backend. Date rendering helpers read this value so
  // existing timestamps are displayed consistently without rewriting them.
  useEffect(() => {
    if (!settings) return;
    const timezone = settings.find((s) => s.key === "app_timezone")?.value;
    if (timezone) setAppTimeZone(timezone);
  }, [settings]);

  // Re-apply appearance when theme changes (sidebar bg depends on light/dark).
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    reapplyAppearanceForTheme();
  }, [theme]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        openCompose();
      } else if (e.key === "Escape" && activeView === "compose") {
        e.preventDefault();
        closeCompose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, openCompose, closeCompose, activeView]);

  // Network status
  useEffect(() => {
    const onOnline = () => {
      setSystemOnline(true);
      setNetworkStatus("online");
    };
    const onOffline = () => {
      setSystemOnline(false);
      setNetworkStatus("offline");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    setNetworkStatus(navigator.onLine ? "online" : "offline");
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [setNetworkStatus]);

  // Optional: listen for backend events (no-op outside Tauri but harmless)
  useEffect(() => {
    // Tauri events not available in web build; reserved for future native wiring.
  }, []);

  return (
    <ContextMenuProvider>
      <div className="flex flex-col h-screen overflow-hidden">
        <div className="flex flex-1 min-h-0">
          {/* Sidebar: flex child on desktop, overlay drawer on mobile/tablet */}
          {!isMobileOrTablet && <Sidebar />}
          {isMobileOrTablet && <Sidebar />}
          <main
            className="flex-1 min-w-0 h-full overflow-hidden flex flex-col"
            style={{
              backdropFilter: "var(--mailgo-content-backdrop)",
              WebkitBackdropFilter: "var(--mailgo-content-backdrop)",
            }}
          >
            {/* Mobile/tablet: hamburger bar */}
            {isMobileOrTablet && (
              <div
                className="flex items-center h-11 px-3 border-b shrink-0"
                style={{ borderColor: "var(--geist-border)" }}
              >
                <button
                  onClick={() => setMobileSidebarOpen(true)}
                  className="h-8 w-8 flex items-center justify-center rounded-geist hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
                  aria-label={t("sidebar.navigation")}
                >
                  <Menu size={18} />
                </button>
              </div>
            )}
            {!systemOnline && (
              <div
                className="flex items-center gap-2 px-4 py-1.5 text-label-12"
                style={{
                  backgroundColor: "var(--geist-red-100)",
                  color: "var(--geist-red-500)",
                }}
              >
                <WifiOff size={13} />
                {t("status.offlineHint")}
              </div>
            )}
            <ViewErrorBoundary key={activeView}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <div className="flex-1 min-h-0 overflow-hidden">
                {activeView === "inbox" && <InboxView />}
                {activeView === "unread" && <MailFolderView unread />}
                {activeView === "all_mail" && <MailFolderView allMail />}
                {activeView === "starred" && <StarredView />}
                {activeView === "drafts" && <DraftsView />}
                {activeView === "search" && <SearchView />}
                {activeView === "ai" && <AIAssistantView />}
                {activeView === "settings" && <SettingsView />}
                {activeView === "compose" && <ComposeView />}
                </div>
              </Suspense>
            </ViewErrorBoundary>
          </main>
        </div>
        {/* Mobile bottom navigation bar */}
        {isMobile && (
          <nav
            className="flex items-center justify-around h-14 shrink-0 border-t"
            style={{
              backgroundColor: "var(--mailgo-sidebar-bg)",
              borderColor: "var(--geist-border)",
            }}
          >
            {(
              [
                { icon: Inbox, view: "inbox" as const, label: t("sidebar.inbox") },
                { icon: Search, view: "search" as const, label: t("sidebar.search") },
                { icon: Bot, view: "ai" as const, label: t("sidebar.aiAssistant") },
                { icon: SettingsIcon, view: "settings" as const, label: t("sidebar.settings") },
              ] as const
            ).map(({ icon: Icon, view, label }) => (
              <button
                key={view}
                onClick={() => setActiveView(view)}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-1 rounded-geist transition-colors min-w-[56px]",
                  activeView === view
                    ? "text-[var(--geist-primary)]"
                    : "text-[var(--geist-tertiary)]",
                )}
              >
                <Icon size={20} />
                <span className="text-[10px]">{label}</span>
              </button>
            ))}
            <button
              onClick={() => openCompose()}
              className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-geist transition-colors min-w-[56px] text-[var(--geist-tertiary)]"
            >
              <PenSquare size={20} />
              <span className="text-[10px]">{t("compose.new")}</span>
            </button>
          </nav>
        )}
        <CommandPalette />
        <ToastContainer />
        <ConfirmDialog />
        <AIMiniChatHost />
        {/* Heartbeat disconnect overlay */}
        {!heartbeatOk && (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center"
            style={{ backdropFilter: "blur(6px)", backgroundColor: "rgba(0,0,0,0.25)" }}
          >
            <div
              className="flex flex-col items-center gap-4 p-8 rounded-geist max-w-sm text-center"
              style={{ backgroundColor: "var(--geist-bg-100)", boxShadow: "var(--shadow-modal)" }}
            >
              <div
                className="h-14 w-14 rounded-full flex items-center justify-center"
                style={{ backgroundColor: "var(--geist-red-100)", color: "var(--geist-red-500)" }}
              >
                <WifiOff size={26} />
              </div>
              <div className="space-y-1.5">
                <p className="text-heading-16" style={{ color: "var(--geist-primary)" }}>
                  {t("status.heartbeatLost")}
                </p>
                <p className="text-copy-13 text-secondary">
                  {t("status.heartbeatLostHint")}
                </p>
              </div>
              <div className="flex items-center gap-2 text-label-12 text-secondary">
                <Loader2 size={13} className="spinner" />
                {t("status.reconnecting")}
              </div>
            </div>
          </div>
        )}
      </div>
    </ContextMenuProvider>
  );
}

function ViewLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full gap-2 text-secondary text-label-13">
      <Loader2 size={14} className="spinner" />
      {i18next.t("common.loading", "Loading…")}
    </div>
  );
}

class ViewErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ViewError]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
          <AlertTriangle
            size={28}
            style={{ color: "var(--geist-amber-500)" }}
          />
          <p className="text-label-14 font-semibold">
            {i18next.t("errorBoundary.title", "Something went wrong")}
          </p>
          <p className="text-copy-13 text-secondary">
            {i18next.t(
              "errorBoundary.description",
              "Please try again or refresh the application.",
            )}
          </p>
          {import.meta.env.DEV && this.state.error && (
            <pre
              className="text-label-12 max-w-[90%] overflow-auto whitespace-pre-wrap text-left p-3 rounded-geist border"
              style={{
                borderColor: "var(--geist-border)",
                color: "var(--geist-red-500)",
              }}
            >
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
          )}
          <button
            onClick={() => this.setState({ error: null })}
            className="btn-secondary btn-small"
          >
            <RefreshCw size={12} /> {i18next.t("errorBoundary.retry", "Retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

