import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Inbox,
  MailOpen,
  Send,
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  Star,
  Settings as SettingsIcon,
  Plus,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Folder,
  Bot,
  RefreshCw,
  Sun,
  Moon,
  Languages,
  Layers,
  LogOut,
  X,
} from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import { useFoldersForAccountsQuery } from "@/hooks/queries/useFolders";
import { useDraftsQuery } from "@/hooks/queries/useDrafts";
import { useMessagesQuery, useStarredCountQuery, useStarredCountByAccountQuery } from "@/hooks/queries/useMessages";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { useSyncStore } from "@/stores/sync.store";
import { folderIconFor } from "@/lib/folderIcons";
import { cn } from "@/lib/utils";
import { AUTH_UNAUTHORIZED_EVENT, authApi, settingsApi, type Folder as FolderType } from "@/lib/api";
import { Tooltip } from "@/components/ui/Tooltip";
import { Avatar } from "@/components/ui/Avatar";
import i18n, { LANG_KEY } from "@/lib/i18n";
import { useIsMobileOrTablet, useIsMobile } from "@/hooks/useBreakpoint";

const MAIL_ROLES = ["inbox", "drafts", "sent", "spam", "trash", "archive"] as const;
const EXPANDED_ACCOUNTS_KEY = "mailgo-sidebar-expanded-accounts";
const SIDEBAR_WIDTH_KEY = "mailgo-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 400;
const COLLAPSED_WIDTH = 56;

type MailRole = (typeof MAIL_ROLES)[number];

interface AccountFolderItem {
  id: number;
  account_id: number;
  name: string;
  role: string;
  unread_count: number;
  total_count: number;
  standard: boolean;
}

const ROLE_LABEL: Record<MailRole, string> = {
  inbox: "sidebar.inbox",
  drafts: "sidebar.drafts",
  sent: "sidebar.sent",
  spam: "sidebar.spam",
  trash: "sidebar.trash",
  archive: "sidebar.archive",
};

const ROLE_ICON: Record<MailRole, typeof Inbox> = {
  inbox: Inbox,
  drafts: FileEdit,
  sent: Send,
  spam: AlertTriangle,
  trash: Trash2,
  archive: Archive,
};

export function Sidebar() {
  const { t } = useTranslation();
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const activeFolderId = useAppStore((s) => s.activeFolderId);
  const setActiveFolderId = useAppStore((s) => s.setActiveFolderId);
  const activeFolderRole = useAppStore((s) => s.activeFolderRole);
  const setActiveFolderRole = useAppStore((s) => s.setActiveFolderRole);
  const activeAccountId = useAppStore((s) => s.activeAccountId);
  const setActiveAccountId = useAppStore((s) => s.setActiveAccountId);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const mobileSidebarOpen = useAppStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useAppStore((s) => s.setMobileSidebarOpen);
  const openCompose = useAppStore((s) => s.openCompose);
  const showUnread = useAppStore((s) => s.showFolderUnreadCount);
  const isMobileOrTablet = useIsMobileOrTablet();
  const isMobile = useIsMobile();

  // Resizable sidebar width — persisted to localStorage.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_SIDEBAR_WIDTH
      ? Math.min(stored, MAX_SIDEBAR_WIDTH)
      : DEFAULT_SIDEBAR_WIDTH;
  });

  // Auto-close the mobile drawer when navigation changes.
  useEffect(() => {
    if (isMobileOrTablet && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, activeFolderId, activeFolderRole, activeAccountId]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const pointerId = e.pointerId;
    e.currentTarget.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, ev.clientX));
      setSidebarWidth(next);
      // Persist on every move so a missed pointerup never loses the value.
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, ev.clientX));
      setSidebarWidth(next);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // Double-click the resize handle to reset to default width.
  const resetWidth = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_SIDEBAR_WIDTH));
  };

  const { data: accounts = [] } = useAccountsQuery();
  const folderAccountIds = useMemo(() => accounts.map((a) => a.id), [accounts]);
  const { data: folders = [] } = useFoldersForAccountsQuery(folderAccountIds);
  const visibleFolders = useMemo(
    () => folders.filter((folder) => !isProviderSystemFolder(folder)),
    [folders],
  );
  const { data: drafts = [] } = useDraftsQuery();
  const { data: imapDraftsSummary } = useMessagesQuery({
    include_drafts: true,
    folder_role: "drafts",
    page: 1,
    page_size: 1,
  });
  const { data: unreadSummary } = useMessagesQuery({
    unread: true,
    exclude_spam_trash: true,
    page: 1,
    page_size: 1,
  });
  const { data: starredCount = 0 } = useStarredCountQuery();
  const { syncNow, phase } = useAutoRefresh({ accountId: activeAccountId });
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const isSyncing = phase === "syncing";
  const seenAccountIds = useRef<Set<number>>(new Set());
  const hasStoredExpandedAccounts = useRef(hasExpandedAccountsStorage());
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(
    () => readExpandedAccounts(),
  );

  useEffect(() => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const account of accounts) {
        if (!seenAccountIds.current.has(account.id)) {
          seenAccountIds.current.add(account.id);
          if (!hasStoredExpandedAccounts.current) {
            next.add(account.id);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  useEffect(() => {
    writeExpandedAccounts(expandedAccounts);
  }, [expandedAccounts]);

  // Total unread per role, summed across ALL accounts. The aggregate
  // sidebar items (收件箱/已发送/… shown when no specific account is
  // selected) must reflect every account, not just the last one loaded.
  const unreadByRole = useMemo(() => {
    const map: Partial<Record<MailRole, number>> = {};
    for (const f of visibleFolders) {
      if (MAIL_ROLES.includes(f.role as MailRole)) {
        const role = f.role as MailRole;
        map[role] = (map[role] ?? 0) + (f.unread_count || 0);
      }
    }
    return map;
  }, [visibleFolders]);
  const unreadTotalCount = unreadSummary?.total ?? (unreadByRole.inbox ?? 0);

  // Per-account inbox unread (for the account row itself, so the user can
  // see which account has new mail without expanding it).
  const unreadInboxByAccount = useMemo(() => {
    const map = new Map<number, number>();
    for (const f of visibleFolders) {
      if (f.role === "inbox") {
        map.set(f.account_id, (map.get(f.account_id) ?? 0) + (f.unread_count || 0));
      }
    }
    return map;
  }, [visibleFolders]);

  // Non-role folders (custom user folders). Shown under a "More" group.
  const customFolders = useMemo(
    () =>
      visibleFolders
        .filter(
          (f) =>
            !MAIL_ROLES.includes(f.role as MailRole) &&
            // Hide pseudo-roles that have their own entry in the sidebar.
            !["starred", "important", "all"].includes(f.role),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [visibleFolders],
  );

  const draftsCount = drafts.length + (imapDraftsSummary?.total ?? 0);
  const effectiveActiveFolderRole = activeFolderRole ?? "inbox";

  const sidebarContent = (
    <aside
      aria-label={t("sidebar.navigation")}
      className={cn(
        "flex flex-col h-full shrink-0 border-r",
        isMobileOrTablet && "w-[280px]",
      )}
      style={
        isMobileOrTablet
          ? {
              backgroundColor: "var(--mailgo-sidebar-bg)",
              backdropFilter: "var(--mailgo-sidebar-backdrop)",
              WebkitBackdropFilter: "var(--mailgo-sidebar-backdrop)",
              borderColor: "var(--geist-border)",
            }
          : {
              width: sidebarCollapsed ? COLLAPSED_WIDTH : sidebarWidth,
              backgroundColor: "var(--mailgo-sidebar-bg)",
              backdropFilter: "var(--mailgo-sidebar-backdrop)",
              WebkitBackdropFilter: "var(--mailgo-sidebar-backdrop)",
              borderColor: "var(--geist-border)",
              transition: "width 150ms ease",
            }
      }
    >
      {/* Top: brand + compose button */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        {!sidebarCollapsed && (
          <div className="flex items-center h-8 gap-2">
            <img
              src="/icon.png"
              alt="MailGo"
              className="h-6 w-6 rounded-geist object-contain shrink-0"
              draggable={false}
            />
            <span className="text-label-14 font-semibold truncate flex-1">
              {t("app.name")}
            </span>
            <Tooltip content={t("sidebar.collapseSidebar")} position="bottom" delay={300}>
              <button
                onClick={toggleSidebar}
                className="h-7 w-7 inline-flex items-center justify-center rounded-geist text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
                aria-label={t("sidebar.collapseSidebar")}
              >
                <PanelLeftClose size={15} />
              </button>
            </Tooltip>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="flex items-center justify-center h-8">
            <Tooltip content={t("sidebar.expandSidebar")} position="right" delay={300}>
              <button
                onClick={toggleSidebar}
                className="h-7 w-7 inline-flex items-center justify-center rounded-geist text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
                aria-label={t("sidebar.expandSidebar")}
              >
                <PanelLeftOpen size={15} />
              </button>
            </Tooltip>
          </div>
        )}
        <div className="flex flex-col items-stretch gap-2">
          <Tooltip content={t("compose.new")} position="right" delay={300}>
            <button
              onClick={() => openCompose()}
              className={cn(
                "inline-flex items-center justify-center gap-2 rounded-geist font-medium transition-colors select-none overflow-hidden",
                sidebarCollapsed ? "h-9 w-9" : "h-9 w-full px-3",
              )}
              style={{
                backgroundColor: "var(--geist-primary)",
                color: "var(--geist-bg-100)",
              }}
              aria-label={t("compose.new")}
            >
              <Plus size={16} className="shrink-0" />
              {!sidebarCollapsed && (
                <span className="text-button-14 flex-1 text-left truncate">
                  {t("compose.new")}
                </span>
              )}
            </button>
          </Tooltip>
          {!sidebarCollapsed && (
            <Tooltip content={t("settings.syncNow")} position="bottom" delay={300}>
              <button
                onClick={() => void syncNow()}
                disabled={isSyncing}
                className={cn(
                  "h-9 w-full px-3 inline-flex items-center justify-center gap-2 rounded-geist border text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)] transition-colors overflow-hidden",
                  isSyncing && "opacity-60 cursor-not-allowed",
                )}
                style={{ borderColor: "var(--geist-border)" }}
                aria-label={t("settings.syncNow")}
              >
                <RefreshCw size={15} className={cn("shrink-0", isSyncing && "spinner")} />
                <span className="text-button-14 flex-1 text-left truncate">
                  {isSyncing ? t("sidebar.syncing") : t("settings.syncNow")}
                </span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-region">
      {/* Mail folders */}
      <nav
        className={cn("flex flex-col gap-0.5 px-2", sidebarCollapsed && "pt-1")}
        aria-label={t("sidebar.mailFolders")}
      >
        <SidebarItem
          icon={<Layers size={15} />}
          label={t("sidebar.allMail")}
          active={activeView === "all_mail"}
          collapsed={sidebarCollapsed}
          onClick={() => {
            setActiveAccountId(null);
            setActiveView("all_mail");
          }}
        />
        <SidebarItem
          icon={<MailOpen size={15} />}
          label={t("sidebar.unread")}
          badge={showUnread ? unreadTotalCount : 0}
          active={activeView === "unread"}
          collapsed={sidebarCollapsed}
          onClick={() => {
            setActiveAccountId(null);
            setActiveFolderId(null);
            setActiveView("unread");
          }}
        />
        {(["drafts", "sent", "spam", "trash"] as const).map((role) => {
          const Icon = ROLE_ICON[role];
          const label = t(ROLE_LABEL[role]);
          const isActive =
            role === "drafts"
              ? activeView === "drafts" && activeAccountId == null
              : activeView === "inbox" &&
                activeAccountId == null &&
                effectiveActiveFolderRole === role;
          const badge =
            role === "drafts" ? draftsCount : showUnread ? (unreadByRole[role] ?? 0) : 0;
          return (
            <SidebarItem
              key={role}
              icon={<Icon size={15} />}
              label={label}
              badge={badge}
              active={isActive}
              collapsed={sidebarCollapsed}
              onClick={() => {
                if (role === "drafts") {
                  setActiveAccountId(null);
                  setActiveFolderRole(role);
                  setActiveView("drafts");
                } else {
                  setActiveAccountId(null);
                  setActiveFolderRole(role);
                  setActiveView("inbox");
                }
              }}
            />
          );
        })}
        {/* Starred — placed above Archive */}
        <SidebarItem
          icon={<Star size={15} />}
          label={t("sidebar.starred")}
          badge={starredCount}
          active={activeView === "starred"}
          collapsed={sidebarCollapsed}
          onClick={() => {
            setActiveAccountId(null);
            setActiveView("starred");
          }}
        />
        {/* Archive — last standard folder */}
        {(() => {
          const role = "archive" as const;
          const Icon = ROLE_ICON[role];
          const label = t(ROLE_LABEL[role]);
          const isActive =
            activeView === "inbox" &&
            activeAccountId == null &&
            effectiveActiveFolderRole === role;
          const badge = showUnread ? (unreadByRole[role] ?? 0) : 0;
          return (
            <SidebarItem
              icon={<Icon size={15} />}
              label={label}
              badge={badge}
              active={isActive}
              collapsed={sidebarCollapsed}
              onClick={() => {
                setActiveAccountId(null);
                setActiveFolderRole(role);
                setActiveView("inbox");
              }}
            />
          );
        })()}
      </nav>

        {!sidebarCollapsed && accounts.length > 0 && (
          <AccountFolderTree
            accounts={accounts}
            folders={visibleFolders}
            expandedAccounts={expandedAccounts}
            activeAccountId={activeAccountId}
            activeFolderId={activeFolderId}
            activeFolderRole={activeFolderRole}
            activeView={activeView}
            showUnread={showUnread}
            unreadInboxByAccount={unreadInboxByAccount}
            onToggle={(accountId) => {
              setExpandedAccounts((prev) => {
                const next = new Set(prev);
                if (next.has(accountId)) next.delete(accountId);
                else next.add(accountId);
                return next;
              });
            }}
            onSelect={(accountId, folderId) => {
              setActiveAccountId(accountId);
              setActiveFolderId(folderId);
              setActiveView("inbox");
            }}
            onSelectRole={(accountId, role) => {
              setActiveAccountId(accountId);
              setActiveFolderId(null);
              if (role === "drafts") {
                setActiveFolderRole(role);
                setActiveView("drafts");
              } else {
                setActiveFolderRole(role);
                setActiveView("inbox");
              }
            }}
            onSelectStarred={(accountId) => {
              setActiveAccountId(accountId);
              setActiveFolderId(null);
              setActiveView("starred");
            }}
          />
        )}

        {/* Custom folders */}
        {!sidebarCollapsed && customFolders.length > 0 && (
          <>
            <SectionLabel icon={<Folder size={11} />}>
              {t("sidebar.more")}
            </SectionLabel>
            <nav className="flex flex-col gap-0.5 px-2" aria-label={t("sidebar.customFolders")}>
              {customFolders.map((folder) => {
                const Icon = folderIconFor(folder.role);
                return (
                  <SidebarItem
                    key={folder.id}
                    icon={<Icon size={15} />}
                    label={folder.name}
                    badge={showUnread ? folder.unread_count : 0}
                    active={
                      activeView === "inbox" && activeFolderId === folder.id
                    }
                    collapsed={sidebarCollapsed}
                    onClick={() => {
                      setActiveFolderId(folder.id);
                      setActiveView("inbox");
                    }}
                  />
                );
              })}
            </nav>
          </>
        )}
      </div>

      {/* Bottom: tools */}
      <div className="divider mx-2" />
      <nav className="flex flex-col gap-0.5 px-2 py-2" aria-label={t("sidebar.tools")}>
        <SidebarItem
          icon={<Bot size={15} />}
          label={t("sidebar.aiAssistant")}
          active={activeView === "ai"}
          collapsed={sidebarCollapsed}
          onClick={() => setActiveView("ai")}
        />

        <div className={cn("flex items-center gap-1", sidebarCollapsed && "flex-col")}>
          <ToolButton
            icon={<SettingsIcon size={15} />}
            label={t("sidebar.settings")}
            active={activeView === "settings"}
            collapsed={sidebarCollapsed}
            onClick={() => setActiveView("settings")}
          />
          <ToolButton
            icon={theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
            label={t("sidebar.toggleTheme")}
            collapsed={sidebarCollapsed}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
          <ToolButton
            icon={<Languages size={15} />}
            label={i18n.language === "zh-CN" ? "English" : "中文"}
            collapsed={sidebarCollapsed}
            onClick={() => {
              const next = i18n.language === "zh-CN" ? "en" : "zh-CN";
              void i18n.changeLanguage(next);
              localStorage.setItem(LANG_KEY, next);
              void settingsApi.update("language", next);
            }}
          />
          <ToolButton
            icon={<LogOut size={15} />}
            label={t("sidebar.logout")}
            collapsed={sidebarCollapsed}
            onClick={() => {
              void authApi.logout().finally(() => {
                window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
              });
            }}
          />
          <SyncDot collapsed={sidebarCollapsed} />
        </div>
      </nav>
    </aside>
  );

  // Mobile / tablet: overlay drawer with backdrop.
  if (isMobileOrTablet) {
    if (!mobileSidebarOpen) return null;
    return (
      <div className="fixed inset-0 z-50 flex">
        <div
          className="flex-1 animate-fade-in-fast"
          style={{ backgroundColor: "rgba(0,0,0,0.32)" }}
          onClick={() => setMobileSidebarOpen(false)}
        />
        <div className="shrink-0 animate-fade-in-fast relative z-10">{sidebarContent}</div>
      </div>
    );
  }

  // Desktop: flex child with resize handle.
  return (
    <div className="flex h-full shrink-0">
      {sidebarContent}
      <div
        role="separator"
        aria-orientation="vertical"
        title={t("sidebar.resizeHint")}
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        className="w-1.5 -ml-[3px] -mr-[3px] cursor-col-resize shrink-0 z-10 hover:bg-[var(--geist-primary)] transition-colors"
      />
    </div>
  );
}

/* ----------------- Sub-components ----------------- */

function SectionLabel({
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className="px-4 pt-3 pb-1 text-label-11 uppercase tracking-wider font-semibold flex items-center gap-1.5"
      style={{ color: "var(--geist-tertiary)" }}
    >
      {icon}
      {children}
    </div>
  );
}

interface SidebarItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  badge?: number;
  onClick: () => void;
}

function SidebarItem({
  icon,
  label,
  active = false,
  collapsed = false,
  badge = 0,
  onClick,
}: SidebarItemProps) {
  const inner = (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "group w-full inline-flex items-center gap-2 rounded-geist text-label-13 transition-colors select-none",
        collapsed ? "h-9 justify-center px-0" : "h-8 px-2.5",
        active
          ? "text-[var(--geist-primary)] font-medium"
          : "text-secondary hover:text-[var(--geist-primary)]",
      )}
      style={
        active
          ? { backgroundColor: "var(--mailgo-sidebar-active)" }
          : undefined
      }
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.backgroundColor = "var(--mailgo-sidebar-hover)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span className="shrink-0 inline-flex items-center justify-center w-4">
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {badge > 0 && (
            <span
              className="text-label-12 font-semibold tabular-nums min-w-[20px] text-right"
              style={{ color: "var(--geist-primary)" }}
            >
              {badge > 999 ? "999+" : badge}
            </span>
          )}
        </>
      )}
      {collapsed && badge > 0 && (
        <span
          className="absolute ml-6 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: "var(--geist-tertiary)" }}
        />
      )}
    </button>
  );

  return inner;
}

function AccountFolderTree({
  accounts,
  folders,
  expandedAccounts,
  activeAccountId,
  activeFolderId,
  activeFolderRole,
  activeView,
  showUnread,
  unreadInboxByAccount,
  onToggle,
  onSelect,
  onSelectRole,
  onSelectStarred,
}: {
  accounts: Array<{ id: number; name: string; email: string; avatar_url?: string; tag_color?: string }>;
  folders: FolderType[];
  expandedAccounts: Set<number>;
  activeAccountId: number | null;
  activeFolderId: number | null;
  activeFolderRole: string | null;
  activeView: string;
  showUnread: boolean;
  unreadInboxByAccount: Map<number, number>;
  onToggle: (accountId: number) => void;
  onSelect: (accountId: number, folderId: number) => void;
  onSelectRole: (accountId: number, role: string) => void;
  onSelectStarred: (accountId: number) => void;
}) {
  const { t } = useTranslation();
  const syncingAccountIds = useSyncStore((s) => s.syncingAccountIds);
  const foldersByAccount = useMemo(() => {
    const map = new Map<number, AccountFolderItem[]>();
    const byAccountAndRole = new Map<string, AccountFolderItem>();
    for (const folder of folders) {
      const role = folder.role as MailRole;
      const isStandard = MAIL_ROLES.includes(role);
      if (isStandard) {
        const key = `${folder.account_id}:${role}`;
        const existing = byAccountAndRole.get(key);
        if (existing) {
          existing.unread_count += folder.unread_count || 0;
          existing.total_count += folder.total_count || 0;
          continue;
        }
        const item: AccountFolderItem = {
          id: folder.id,
          account_id: folder.account_id,
          name: folder.name,
          role,
          unread_count: folder.unread_count || 0,
          total_count: folder.total_count || 0,
          standard: true,
        };
        byAccountAndRole.set(key, item);
        const list = map.get(folder.account_id) ?? [];
        list.push(item);
        map.set(folder.account_id, list);
      } else {
        const list = map.get(folder.account_id) ?? [];
        list.push({
          id: folder.id,
          account_id: folder.account_id,
          name: folder.name,
          role: folder.role,
          unread_count: folder.unread_count || 0,
          total_count: folder.total_count || 0,
          standard: false,
        });
        map.set(folder.account_id, list);
      }
    }
    const order = new Map<string, number>(MAIL_ROLES.map((role, index) => [role, index]));
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ai = order.get(a.role) ?? 99;
        const bi = order.get(b.role) ?? 99;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
    }
    return map;
  }, [folders]);

  return (
    <nav className="mt-2 px-2 space-y-1" aria-label={t("sidebar.accountFolders")}>
      {accounts.map((account) => {
        const accountFolders = foldersByAccount.get(account.id) ?? [];
        const expanded = expandedAccounts.has(account.id);
        const inboxUnread = unreadInboxByAccount.get(account.id) ?? 0;
        return (
          <div key={account.id}>
            <button
              onClick={() => onToggle(account.id)}
              className="w-full h-8 px-2 inline-flex items-center gap-2 rounded-geist text-label-13 text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
              aria-expanded={expanded}
            >
              <ChevronDown
                size={13}
                className="shrink-0"
                style={{
                  transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 120ms",
                }}
              />
              <Avatar
                src={account.avatar_url || undefined}
                name={account.name}
                email={account.email}
                tagColor={account.tag_color || undefined}
                size={20}
              />
              <span className="flex-1 min-w-0 text-left truncate">
                {account.name || account.email}
                {account.name && account.email && (
                  <span className="text-secondary ml-1">({account.email})</span>
                )}
              </span>
              {showUnread && inboxUnread > 0 && (
                <span
                  className="text-label-12 font-semibold tabular-nums shrink-0"
                  style={{ color: "var(--geist-primary)" }}
                >
                  {inboxUnread > 999 ? "999+" : inboxUnread}
                </span>
              )}
              {syncingAccountIds.has(account.id) && (
                <RefreshCw
                  size={12}
                  className="spinner shrink-0"
                  style={{ color: "var(--geist-secondary)" }}
                />
              )}
            </button>
            {expanded && (
              <div className="ml-5 mt-0.5 space-y-0.5">
                <AccountStarredEntry
                  accountId={account.id}
                  active={activeAccountId === account.id && activeView === "starred"}
                  onSelect={onSelectStarred}
                />
                {accountFolders.map((folder) => {
                  const Icon = folderIconFor(folder.role);
                  const role = folder.role as MailRole;
                  const label = MAIL_ROLES.includes(role)
                    ? t(ROLE_LABEL[role])
                    : folder.name;
                  const active =
                    activeAccountId === account.id &&
                    (folder.standard
                      ? activeFolderId == null && activeFolderRole === folder.role
                      : activeFolderId === folder.id);
                  return (
                    <button
                      key={folder.id}
                      onClick={() =>
                        folder.standard
                          ? onSelectRole(account.id, folder.role)
                          : onSelect(account.id, folder.id)
                      }
                      className={cn(
                        "w-full h-7 px-2 inline-flex items-center gap-2 rounded-geist text-label-12 transition-colors",
                        active
                          ? "font-medium text-[var(--geist-primary)]"
                          : "text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)]",
                      )}
                      style={
                        active
                          ? { backgroundColor: "var(--mailgo-sidebar-active)" }
                          : undefined
                      }
                    >
                      <Icon size={13} className="shrink-0" />
                      <span className="flex-1 min-w-0 text-left truncate">{label}</span>
                      {showUnread && shouldShowFolderUnreadBadge(folder) && folder.unread_count > 0 && (
                        <span
                          className="text-label-12 font-semibold tabular-nums"
                          style={{ color: "var(--geist-primary)" }}
                        >
                          {folder.unread_count > 999 ? "999+" : folder.unread_count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function shouldShowFolderUnreadBadge(folder: AccountFolderItem): boolean {
  return !folder.standard || folder.role !== "drafts";
}

/** Per-account starred entry with live count badge. */
function AccountStarredEntry({
  accountId,
  active,
  onSelect,
}: {
  accountId: number;
  active: boolean;
  onSelect: (accountId: number) => void;
}) {
  const { t } = useTranslation();
  const { data: count = 0 } = useStarredCountByAccountQuery(accountId);

  return (
    <button
      onClick={() => onSelect(accountId)}
      className={cn(
        "w-full h-7 px-2 inline-flex items-center gap-2 rounded-geist text-label-12 transition-colors",
        active
          ? "font-medium text-[var(--geist-primary)]"
          : "text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)]",
      )}
      style={active ? { backgroundColor: "var(--mailgo-sidebar-active)" } : undefined}
    >
      <Star size={13} className="shrink-0" />
      <span className="flex-1 min-w-0 text-left truncate">{t("sidebar.starred")}</span>
      {count > 0 && (
        <span
          className="text-label-12 font-semibold tabular-nums"
          style={{ color: "var(--geist-primary)" }}
        >
          {count > 999 ? "999+" : count}
        </span>
      )}
    </button>
  );
}

function readExpandedAccounts(): Set<number> {
  try {
    const raw = localStorage.getItem(EXPANDED_ACCOUNTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => Number(id)).filter(Number.isFinite));
  } catch {
    return new Set();
  }
}

function hasExpandedAccountsStorage(): boolean {
  try {
    return localStorage.getItem(EXPANDED_ACCOUNTS_KEY) !== null;
  } catch {
    return false;
  }
}

function writeExpandedAccounts(value: Set<number>) {
  try {
    localStorage.setItem(EXPANDED_ACCOUNTS_KEY, JSON.stringify([...value]));
  } catch {
    /* ignore */
  }
}

function isProviderSystemFolder(folder: FolderType): boolean {
  const name = (folder.name || "").trim().toLowerCase();
  if (!name) return false;
  if (name === "[gmail]" || name === "[google mail]") return true;
  if (name.startsWith("[gmail]/") || name.startsWith("[google mail]/")) return true;
  if (name === "inbox.spam") return true;
  return false;
}

function ToolButton({
  icon,
  label,
  active = false,
  collapsed = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-geist transition-colors text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)]",
        collapsed ? "h-9 w-9" : "h-8 w-8",
        active && "font-medium text-[var(--geist-primary)]",
      )}
      style={active ? { backgroundColor: "var(--mailgo-sidebar-active)" } : undefined}
    >
      <span className="inline-flex items-center justify-center shrink-0">{icon}</span>
    </button>
  );
}

/* --------- Sync status dot (inline next to tool buttons) --------- */

function formatSyncTime(iso: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return t("sidebar.neverSynced");
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return t("sidebar.neverSynced");
  // Go's sql.NullTime zero value is 0001-01-01 — treat as "never synced".
  if (ts < 946684800000) return t("sidebar.neverSynced"); // before year 2000
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return t("sidebar.justSynced");
  if (s < 60) return t("sidebar.secondsAgo", { seconds: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("sidebar.minutesAgo", { minutes: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("sidebar.hoursAgo", { hours: h });
  return t("sidebar.daysAgo", { days: Math.floor(h / 24) });
}

function getCheckInterval(): number {
  try {
    const raw = localStorage.getItem("mailgo-setting:check_interval");
    const v = Number(raw || "300");
    return Number.isFinite(v) && v >= 30 ? v : 300;
  } catch {
    return 300;
  }
}

function SyncDot({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const phase = useSyncStore((s) => s.phase);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const networkStatus = useAppStore((s) => s.networkStatus);

  const isSyncing = phase === "syncing";
  const isError = phase === "error";
  const isOffline = networkStatus === "offline";

  // Live countdown for tooltip.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const dotColor = isOffline
    ? "var(--geist-gray-400)"
    : isError
      ? "var(--geist-red-500)"
      : "var(--geist-green-500)";

  let label: string;
  if (isOffline) {
    label = t("sidebar.offline");
  } else if (isSyncing) {
    label = t("sidebar.syncing");
  } else if (isError) {
    label = t("sidebar.syncFailed");
  } else if (lastSyncAt && Date.parse(lastSyncAt) >= 946684800000) {
    const intervalSec = getCheckInterval();
    const elapsed = Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000);
    const remaining = Math.max(0, intervalSec - elapsed);
    const lastLabel = formatSyncTime(lastSyncAt, t);
    if (remaining <= 0) {
      label = `${lastLabel} · ${t("sidebar.aboutToSync")}`;
    } else if (remaining < 60) {
      label = `${lastLabel} · ${t("sidebar.secondsUntilSync", { seconds: remaining })}`;
    } else {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      label = `${lastLabel} · ${s > 0 ? t("sidebar.minutesUntilSync", { minutes: m, seconds: s }) : t("sidebar.minutesUntilSyncShort", { minutes: m })}`;
    }
  } else {
    label = t("sidebar.connected");
  }

  return (
    <Tooltip content={label} position="right" delay={300}>
      <button
        className={cn(
          "inline-flex items-center justify-center rounded-geist transition-colors hover:bg-[var(--mailgo-sidebar-hover)]",
          collapsed ? "h-9 w-9" : "h-8 w-8",
        )}
        aria-label={label}
      >
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full",
            isSyncing && "animate-pulse",
          )}
          style={{ backgroundColor: dotColor }}
        />
      </button>
    </Tooltip>
  );
}
