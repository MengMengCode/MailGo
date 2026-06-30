import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";

/**
 * Bidirectional sync between the browser URL and Zustand navigation state.
 *
 * URL → State:  on mount / browser back-forward / direct link
 * State → URL:  when the user navigates via sidebar / compose / etc.
 *
 * A path ref prevents infinite loops: the location effect skips when the
 * URL matches what we just pushed from the Zustand subscription.
 */

// ─── URL → State ──────────────────────────────────────────────────

function applyUrlToState(pathname: string, search: string) {
  const s = useAppStore.getState();
  const parts = pathname.split("/").filter(Boolean);

  const apply = (patch: {
    view?: string;
    accountId?: number | null;
    folderId?: number | null;
    folderRole?: string | null;
    messageId?: number | null;
  }) => {
    if (patch.accountId !== undefined) s.setActiveAccountId(patch.accountId);
    if (patch.folderId !== undefined) s.setActiveFolderId(patch.folderId);
    if (patch.folderRole !== undefined) s.setActiveFolderRole(patch.folderRole);
    if (patch.messageId !== undefined) s.setSelectedMessageId(patch.messageId);
    if (patch.view) s.setActiveView(patch.view as any);
  };

  // ── /compose?reply=…&forward=…&draft=… ──
  if (parts[0] === "compose") {
    const params = new URLSearchParams(search);
    const replyId = params.get("reply");
    const forwardId = params.get("forward");
    const draftId = params.get("draft");
    if (draftId) {
      s.openDraft(Number(draftId));
    } else if (replyId) {
      s.openCompose("reply", Number(replyId));
    } else if (forwardId) {
      s.openCompose("forward", Number(forwardId));
    } else {
      s.openCompose("new");
    }
    return;
  }

  // ── /message/:id ──
  if (parts[0] === "message" && parts[1]) {
    apply({ messageId: Number(parts[1]), view: "inbox" });
    return;
  }

  // ── /account/:id/… ──
  if (parts[0] === "account" && parts[1]) {
    const accountId = Number(parts[1]);

    if (parts[2] === "folder" && parts[3]) {
      const folderId = Number(parts[3]);
      const messageId = parts[5] ? Number(parts[5]) : null;
      apply({ accountId, folderId, folderRole: null, messageId, view: "inbox" });
      return;
    }

    if (parts[2] === "role" && parts[3]) {
      const role = parts[3];
      const messageId = parts[5] ? Number(parts[5]) : null;
      const view = role === "drafts" ? "drafts" : "inbox";
      apply({ accountId, folderId: null, folderRole: role, messageId, view });
      return;
    }

    if (parts[2] === "drafts") {
      apply({ accountId, folderId: null, folderRole: "drafts", messageId: null, view: "drafts" });
      return;
    }

    apply({ accountId, folderId: null, folderRole: "inbox", messageId: null, view: "inbox" });
    return;
  }

  // ── /settings/:tab ──
  if (parts[0] === "settings") {
    const validTabs = ["general", "accounts", "appearance", "ai", "security", "about"];
    const tab = parts[1] && validTabs.includes(parts[1]) ? parts[1] : "general";
    s.setSettingsTab(tab);
    apply({
      view: "settings",
      accountId: null,
      folderId: null,
      folderRole: null,
      messageId: null,
    });
    return;
  }

  // ── Simple top-level routes ──
  const simpleViewMap: Record<string, string> = {
    "": "inbox",
    inbox: "inbox",
    unread: "unread",
    all: "all_mail",
    starred: "starred",
    drafts: "drafts",
    search: "search",
    ai: "ai",
  };

  const view = simpleViewMap[parts[0] ?? ""];
  if (view) {
    apply({
      view,
      accountId: null,
      folderId: null,
      folderRole: view === "drafts" ? "drafts" : view === "inbox" ? "inbox" : null,
      messageId: null,
    });
    return;
  }

  apply({ view: "inbox", accountId: null, folderId: null, folderRole: "inbox", messageId: null });
}

// ─── State → URL ──────────────────────────────────────────────────

function stateToPath(): string {
  const s = useAppStore.getState();
  const { activeView, activeAccountId, activeFolderId, activeFolderRole, selectedMessageId } = s;

  if (activeView === "compose") {
    const params = new URLSearchParams();
    if (s.composeDraftId) params.set("draft", String(s.composeDraftId));
    else if (s.composeReplyId && s.composeMode === "reply") params.set("reply", String(s.composeReplyId));
    else if (s.composeReplyId && s.composeMode === "forward") params.set("forward", String(s.composeReplyId));
    const qs = params.toString();
    return `/compose${qs ? `?${qs}` : ""}`;
  }

  const simpleViews: Record<string, string> = {
    all_mail: "/all",
    starred: "/starred",
    unread: "/unread",
    search: "/search",
    ai: "/ai",
  };
  if (!activeAccountId && simpleViews[activeView]) {
    return simpleViews[activeView];
  }

  if (activeView === "settings") {
    const tab = s.settingsTab || "general";
    return `/settings/${tab}`;
  }

  if (activeAccountId) {
    const msgSuffix = selectedMessageId ? `/message/${selectedMessageId}` : "";

    if (activeView === "drafts" || activeFolderRole === "drafts") {
      return `/account/${activeAccountId}/drafts${msgSuffix}`;
    }
    if (activeFolderId) {
      return `/account/${activeAccountId}/folder/${activeFolderId}${msgSuffix}`;
    }
    if (activeFolderRole && activeFolderRole !== "inbox") {
      return `/account/${activeAccountId}/role/${activeFolderRole}${msgSuffix}`;
    }
    return `/account/${activeAccountId}${msgSuffix}`;
  }

  if (activeView === "drafts") return "/drafts";
  if (selectedMessageId) return `/message/${selectedMessageId}`;
  return "/inbox";
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useUrlSync() {
  const location = useLocation();
  const navigate = useNavigate();
  // Tracks the path we just pushed from the Zustand subscription so the
  // location effect can skip it without needing fragile timing.
  const lastPushedRef = useRef<string | null>(null);

  // ── URL → State: on mount and on browser back/forward ──
  useEffect(() => {
    const currentPath = location.pathname + location.search;

    // Skip if this URL was just pushed by the Zustand → URL direction.
    if (lastPushedRef.current === currentPath) {
      lastPushedRef.current = null;
      return;
    }

    applyUrlToState(location.pathname, location.search);
  }, [location.pathname, location.search]);

  // ── State → URL: subscribe to Zustand navigation changes ──
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prevState) => {
      const navChanged =
        state.activeView !== prevState.activeView ||
        state.activeAccountId !== prevState.activeAccountId ||
        state.activeFolderId !== prevState.activeFolderId ||
        state.activeFolderRole !== prevState.activeFolderRole ||
        state.selectedMessageId !== prevState.selectedMessageId ||
        state.composeDraftId !== prevState.composeDraftId ||
        state.composeReplyId !== prevState.composeReplyId ||
        state.composeMode !== prevState.composeMode ||
        state.settingsTab !== prevState.settingsTab;

      if (!navChanged) return;

      const path = stateToPath();
      const currentPath = window.location.pathname + window.location.search;
      if (path === currentPath) return;

      lastPushedRef.current = path;
      navigate(path, { replace: false });
    });

    return unsub;
  }, [navigate]);
}
