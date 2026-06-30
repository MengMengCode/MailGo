import { create } from "zustand";
import { persist } from "zustand/middleware";
import { settingsApi } from "@/lib/api";

export type ActiveView =
  | "inbox"
  | "unread"
  | "all_mail"
  | "compose"
  | "settings"
  | "search"
  | "starred"
  | "ai"
  | "drafts";

export type ThemeMode = "light" | "dark" | "system";

export type NetworkStatus = "online" | "offline";

export type ComposeMode = "new" | "reply" | "reply_all" | "forward";

export interface MessageFilters {
  hasAttachment: boolean;
  from: string;
  subject: string;
  dateAfter: string;
  dateBefore: string;
}

const EMPTY_FILTERS: MessageFilters = {
  hasAttachment: false,
  from: "",
  subject: "",
  dateAfter: "",
  dateBefore: "",
};

export interface AppState {
  // Sidebar
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;

  // Mobile sidebar drawer
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;

  // Active view
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;

  // Selected folder (per account)
  activeFolderId: number | null;
  setActiveFolderId: (id: number | null) => void;
  activeFolderRole: string | null;
  setActiveFolderRole: (role: string | null) => void;

  // Selected account
  activeAccountId: number | null;
  setActiveAccountId: (id: number | null) => void;

  // Selected message detail
  selectedMessageId: number | null;
  setSelectedMessageId: (id: number | null) => void;

  // Batch mode
  batchMode: boolean;
  toggleBatchMode: () => void;
  selectedMessageIds: Set<number>;
  toggleMessageSelection: (id: number) => void;
  selectAllMessages: (ids: number[]) => void;
  clearMessageSelection: () => void;

  // Compose
  composeMode: ComposeMode;
  composeReplyId: number | null;
  /** When the user resumes a draft, the draft id is tracked here so the
   *  auto-save loop in ComposeView knows to PATCH instead of POST. */
  composeDraftId: number | null;
  composeKey: number;
  openCompose: (mode?: ComposeMode, replyId?: number | null) => void;
  openDraft: (draftId: number) => void;
  closeCompose: () => void;

  // Search
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Message filters
  messageFilters: MessageFilters;
  setMessageFilters: (f: Partial<MessageFilters>) => void;
  clearMessageFilters: () => void;

  // Command palette
  paletteOpen: boolean;
  togglePalette: () => void;
  setPaletteOpen: (v: boolean) => void;

  // Theme
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  /** Apply theme from backend sync — does NOT write back to backend. */
  applyThemeFromBackend: (theme: ThemeMode) => void;

  // Network status (derived from browser online/offline events)
  networkStatus: NetworkStatus;
  setNetworkStatus: (s: NetworkStatus) => void;

  // Settings
  showFolderUnreadCount: boolean;
  setShowFolderUnreadCount: (v: boolean) => void;
  conversationViewEnabled: boolean;
  setConversationViewEnabled: (v: boolean) => void;

  // Settings tab (persisted so refresh keeps the same tab)
  settingsTab: string;
  setSettingsTab: (tab: string) => void;
}

const THEME_KEY = "mailgo-theme";

function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") return;
  let actual: "light" | "dark" = "light";
  if (theme === "system") {
    actual = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } else {
    actual = theme;
  }
  document.documentElement.setAttribute("data-theme", actual);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      mobileSidebarOpen: false,
      setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),

      activeView: "inbox",
      setActiveView: (view) =>
        set((s) => ({
          activeView: view,
          selectedMessageId: view === "ai" ? s.selectedMessageId : null,
        })),

      activeFolderId: null,
      setActiveFolderId: (id) =>
        set({ activeFolderId: id, activeFolderRole: null, selectedMessageId: null }),
      activeFolderRole: "inbox",
      setActiveFolderRole: (role) =>
        set({ activeFolderRole: role, activeFolderId: null, selectedMessageId: null }),

      activeAccountId: null,
      setActiveAccountId: (id) => set({ activeAccountId: id }),

      selectedMessageId: null,
      setSelectedMessageId: (id) => set({ selectedMessageId: id }),

      batchMode: false,
      toggleBatchMode: () =>
        set((s) => ({
          batchMode: !s.batchMode,
          selectedMessageIds: new Set(),
        })),
      selectedMessageIds: new Set<number>(),
      toggleMessageSelection: (id) =>
        set((s) => {
          const next = new Set(s.selectedMessageIds);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedMessageIds: next };
        }),
      selectAllMessages: (ids) => set({ selectedMessageIds: new Set(ids) }),
      clearMessageSelection: () => set({ selectedMessageIds: new Set() }),

      composeMode: "new",
      composeReplyId: null,
      composeDraftId: null,
      composeKey: 0,
      openCompose: (mode = "new", replyId = null) => {
        const next = get().composeKey + 1;
        set({
          composeMode: mode,
          composeReplyId: replyId,
          composeDraftId: null,
          composeKey: next,
          activeView: "compose",
        });
      },
      openDraft: (draftId) => {
        const next = get().composeKey + 1;
        set({
          composeMode: "new",
          composeReplyId: null,
          composeDraftId: draftId,
          composeKey: next,
          activeView: "compose",
        });
      },
      closeCompose: () =>
        set({
          activeView: "inbox",
          composeMode: "new",
          composeReplyId: null,
          composeDraftId: null,
        }),

      searchQuery: "",
      setSearchQuery: (q) => set({ searchQuery: q }),

      messageFilters: { ...EMPTY_FILTERS },
      setMessageFilters: (f) =>
        set((s) => ({ messageFilters: { ...s.messageFilters, ...f } })),
      clearMessageFilters: () => set({ messageFilters: { ...EMPTY_FILTERS } }),

      paletteOpen: false,
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setPaletteOpen: (v) => set({ paletteOpen: v }),

      theme: "light",
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
        // Sync to backend for cross-device persistence
        void settingsApi.update("theme", theme);
      },
      applyThemeFromBackend: (theme) => {
        set({ theme });
        applyTheme(theme);
        // No backend write — this IS the backend value.
      },

      networkStatus:
        typeof navigator !== "undefined" && !navigator.onLine
          ? "offline"
          : "online",
      setNetworkStatus: (s) => set({ networkStatus: s }),

      showFolderUnreadCount: true,
      setShowFolderUnreadCount: (v) => set({ showFolderUnreadCount: v }),
      conversationViewEnabled: true,
      setConversationViewEnabled: (v) => set({ conversationViewEnabled: v }),

      settingsTab: "general",
      setSettingsTab: (tab) => set({ settingsTab: tab }),
    }),
    {
      name: "mailgo-app",
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        activeView: s.activeView,
        activeFolderId: s.activeFolderId,
        activeFolderRole: s.activeFolderRole,
        activeAccountId: s.activeAccountId,
        theme: s.theme,
        searchQuery: s.searchQuery,
        messageFilters: s.messageFilters,
        showFolderUnreadCount: s.showFolderUnreadCount,
        conversationViewEnabled: s.conversationViewEnabled,
        settingsTab: s.settingsTab,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.theme) applyTheme(state.theme);
      },
    },
  ),
);

/** Apply theme on initial load (before zustand rehydration). */
export function initThemeFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      applyTheme(stored);
    } else if (stored) {
      // Corrupted value — reset to light.
      localStorage.removeItem(THEME_KEY);
      applyTheme("light");
    }
  } catch {
    /* ignore */
  }
}
