import { useMemo, useRef, useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  Trash2,
  MailOpen,
  Mail,
  Star,
  Inbox,
  RotateCcw,
} from "lucide-react";
import { draftsApi, type Message } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { MessageItem } from "./MessageItem";
import { MessageListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useBatchMessageAction } from "@/hooks/mutations/useMessageMutations";
import { showToast } from "@/stores/toast.store";
import { useConfirmStore } from "@/stores/confirm.store";
import { cn } from "@/lib/utils";
import {
  conversationKey as sharedConversationKey,
  messageTime as sharedMessageTime,
} from "@/lib/conversation";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  onSelectMessage: (id: number) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isFetchingMore?: boolean;
  accountColor?: (msg: Message) => string | undefined;
  accountLabel?: (msg: Message) => string | undefined;
  spamFolderId?: number;
  archiveFolderId?: number;
  getSpamFolderId?: (msg: Message) => number | undefined;
  getArchiveFolderId?: (msg: Message) => number | undefined;
  getInboxFolderId?: (msg: Message) => number | undefined;
  folderRole?: string;
  emptyIcon?: ReactNode;
  disableConversationGrouping?: boolean;
  onOpenThread?: (thread: { id: number; key: string; messages: Message[] }) => void;
}

interface MessageListItem {
  key: string;
  message: Message;
  messages: Message[];
  ids: number[];
  unreadCount: number;
}

export function MessageList({
  messages,
  loading,
  error,
  onRetry,
  onSelectMessage,
  hasMore,
  onLoadMore,
  isFetchingMore,
  accountColor,
  accountLabel,
  spamFolderId,
  archiveFolderId,
  getSpamFolderId,
  getArchiveFolderId,
  getInboxFolderId,
  folderRole,
  emptyIcon,
  disableConversationGrouping = false,
  onOpenThread,
}: MessageListProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const selectedId = useAppStore((s) => s.selectedMessageId);
  const selectedIds = useAppStore((s) => s.selectedMessageIds);
  const selectAll = useAppStore((s) => s.selectAllMessages);
  const clearSelection = useAppStore((s) => s.clearMessageSelection);
  const conversationViewEnabled = useAppStore((s) => s.conversationViewEnabled);
  const batchAction = useBatchMessageAction();
  const confirm = useConfirmStore((s) => s.confirm);

  const listItems = useMemo(
    () =>
      conversationViewEnabled && !disableConversationGrouping
        ? groupMessages(messages)
        : dedupeMessages(messages).map((message) => ({
            key: String(message.id),
            message,
            messages: [message],
            ids: [message.id],
            unreadCount: message.is_read ? 0 : 1,
          })),
    [conversationViewEnabled, disableConversationGrouping, messages],
  );
  const visibleIds = useMemo(
    () => listItems.flatMap((item) => item.ids),
    [listItems],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (typeof window !== "undefined" && window.innerWidth < 640 ? 68 : 88),
    overscan: 6,
  });

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId) return;
    const idx = listItems.findIndex((item) => item.ids.includes(selectedId));
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedId, listItems, virtualizer]);

  // Infinite scroll: when the user scrolls near the bottom of the list,
  // automatically fetch the next page (in addition to the manual
  // "Load more" button). We debounce via a ref guard so it only fires
  // once per edge reach until the fetch settles.
  const loadingMoreRef = useRef(false);
  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    if (!hasMore || !onLoadMore) return;
    if (loadingMoreRef.current || isFetchingMore) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 240) {
      loadingMoreRef.current = true;
      onLoadMore();
    }
  };
  useEffect(() => {
    // Reset the guard once a fetch settles so the next edge-reach fires again.
    if (!isFetchingMore) loadingMoreRef.current = false;
  }, [isFetchingMore]);

  const allSelected = useMemo(
    () => visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id)),
    [selectedIds, visibleIds],
  );

  // --- Drag-to-select (like Windows Explorer) ---
  // When the user presses the left mouse button on empty space in the list
  // and drags, we select all items whose row intersects the drag rectangle.
  const [dragRect, setDragRect] = useState<DOMRect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragSelecting = useRef(false);

  const onListPointerDown = (e: React.PointerEvent) => {
    // Only start drag-select on left click in the scroll container itself
    // (not on a message item or checkbox).
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-msg-item]")) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragSelecting.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onListPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = Math.abs(e.clientX - dragStart.current.x);
    const dy = Math.abs(e.clientY - dragStart.current.y);
    if (!dragSelecting.current && (dx > 4 || dy > 4)) {
      dragSelecting.current = true;
      // Clear previous selection when starting a new drag.
      clearSelection();
    }
    if (dragSelecting.current && parentRef.current) {
      const containerRect = parentRef.current.getBoundingClientRect();
      const rect = new DOMRect(
        Math.min(dragStart.current.x, e.clientX),
        Math.min(dragStart.current.y, e.clientY),
        dx,
        dy,
      );
      setDragRect(rect);
      // Select items whose virtual position intersects the drag rect.
      const items = parentRef.current.querySelectorAll("[data-msg-item]");
      const newIds: number[] = [];
      items.forEach((el) => {
        const elRect = el.getBoundingClientRect();
        if (
          rect.top < elRect.bottom &&
          rect.bottom > elRect.top &&
          rect.left < elRect.right &&
          rect.right > elRect.left
        ) {
          const ids = (el.getAttribute("data-msg-ids") || "")
            .split(",")
            .map((id) => Number(id))
            .filter(Boolean);
          newIds.push(...ids);
        }
      });
      // Use selectAll to set the full set (replaces selection).
      selectAll(newIds);
    }
  };

  const onListPointerUp = () => {
    dragStart.current = null;
    dragSelecting.current = false;
    setDragRect(null);
  };


  // Only show the skeleton on the very first load (no data yet).
  // Background refetches (sync, stale-while-revalidate) keep the
  // existing list visible so the user doesn't lose their scroll
  // position or see already-loaded items disappear.
  if (loading && messages.length === 0) {
    return <MessageListSkeleton />;
  }

  if (error && messages.length === 0) {
    const message = error instanceof Error ? error.message : "";
    return (
      <EmptyState
        icon={<Inbox size={22} />}
        title={t("common.loadFailed")}
        description={message || t("inbox.noMessagesHint")}
        action={
          onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-geist border px-3 text-label-13 transition-colors hover:bg-[var(--geist-gray-100)]"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <RotateCcw size={14} />
              {t("common.tryAgain")}
            </button>
          ) : undefined
        }
      />
    );
  }

  if (messages.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon ?? <Inbox size={22} />}
        title={t("common.noMessages")}
        description={t("inbox.noMessagesHint")}
      />
    );
  }

  const handleBatch = async (
    action:
      | "archive"
      | "delete"
      | "restore"
      | "permanent_delete"
      | "mark_read"
      | "mark_unread"
      | "star"
      | "unstar",
  ) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (action === "delete") {
      const ok = await confirm({
        title: t("batch.deleteTitle", { count: ids.length }),
        message: t("batch.deleteConfirm", { count: ids.length }),
        confirmLabel: t("batch.deleteButton"),
        destructive: true,
      });
      if (!ok) return;
    }
    if (action === "permanent_delete") {
      const ok = await confirm({
        title: t("messageActions.deleteForever", "Delete forever"),
        message: t("batch.permanentDeleteConfirm", { count: ids.length }),
        confirmLabel: t("common.delete"),
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      const localDraftIds = ids
        .filter((id) => id >= 1_000_000_000)
        .map((id) => id - 1_000_000_000);
      const messageIds = ids.filter((id) => id < 1_000_000_000);
      if (localDraftIds.length > 0) {
        if (action === "delete") {
          await Promise.all(localDraftIds.map((id) => draftsApi.delete(id)));
        } else if (action === "restore") {
          await Promise.all(localDraftIds.map((id) => draftsApi.restore(id)));
        } else if (action === "permanent_delete") {
          await Promise.all(localDraftIds.map((id) => draftsApi.permanentDelete(id)));
        }
        await qc.invalidateQueries({ queryKey: ["drafts"] });
      }
      if (messageIds.length > 0) {
        await batchAction.mutateAsync({ action, ids: messageIds });
      }
      showToast(t("batch.success", { count: ids.length }), "success");
      clearSelection();
    } catch {
      showToast(t("batch.failed"), "error");
    }
  };

  const hasSelection = selectedIds.size > 0;

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0 text-label-13"
        style={{
          backgroundColor: "var(--geist-bg-100)",
          borderColor: "var(--geist-border)",
        }}
      >
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {
              if (allSelected) clearSelection();
              else selectAll(visibleIds);
            }}
            aria-label={t("batch.selectAll")}
            className="h-3.5 w-3.5 rounded accent-[var(--geist-primary)]"
          />
          <span className="text-secondary">
            {hasSelection
              ? t("batch.selected", { count: selectedIds.size })
              : t("batch.selectAll")}
          </span>
        </label>
        <div className={cn("flex items-center gap-1 ml-2", !hasSelection && "opacity-40 pointer-events-none")}>
          {folderRole === "trash" ? (
            <>
              <BatchBtn
                icon={RotateCcw}
                label={t("messageActions.restore", "Restore")}
                onClick={() => handleBatch("restore")}
                disabled={batchAction.isPending || !hasSelection}
              />
              <BatchBtn
                icon={Trash2}
                label={t("messageActions.deleteForever", "Delete forever")}
                onClick={() => handleBatch("permanent_delete")}
                disabled={batchAction.isPending || !hasSelection}
                danger
              />
            </>
          ) : (
            <>
              <BatchBtn
                icon={Archive}
                label={t("messageActions.archive")}
                onClick={() => handleBatch("archive")}
                disabled={batchAction.isPending || !hasSelection}
              />
              <BatchBtn
                icon={Trash2}
                label={t("common.delete")}
                onClick={() => handleBatch("delete")}
                disabled={batchAction.isPending || !hasSelection}
                danger
              />
            </>
          )}
          <BatchBtn
            icon={MailOpen}
            label={t("messageActions.markRead")}
            onClick={() => handleBatch("mark_read")}
            disabled={batchAction.isPending || !hasSelection}
          />
          <BatchBtn
            icon={Mail}
            label={t("messageActions.markUnread")}
            onClick={() => handleBatch("mark_unread")}
            disabled={batchAction.isPending || !hasSelection}
          />
          <BatchBtn
            icon={Star}
            label={t("messageActions.star")}
            onClick={() => handleBatch("star")}
            disabled={batchAction.isPending || !hasSelection}
          />
        </div>
      </div>
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto scroll-region"
        onPointerDown={onListPointerDown}
        onPointerMove={onListPointerMove}
        onPointerUp={onListPointerUp}
        onPointerCancel={onListPointerUp}
        onScroll={onScroll}
        style={{ position: "relative", userSelect: dragSelecting.current ? "none" : undefined }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = listItems[vi.index];
            const m = item.message;
            return (
              <div
                key={item.key}
                data-msg-item
                data-msg-id={m.id}
                data-msg-ids={item.ids.join(",")}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <MessageItem
                  message={m}
                  isSelected={item.ids.some((id) => id === selectedId)}
                  onSelect={() => {
                    if (
                      conversationViewEnabled &&
                      !disableConversationGrouping &&
                      item.messages.length > 1 &&
                      onOpenThread
                    ) {
                      onOpenThread({ id: m.id, key: item.key, messages: item.messages });
                    } else {
                      onSelectMessage(m.id);
                    }
                  }}
                  accountColor={accountColor?.(m)}
                  accountLabel={accountLabel?.(m)}
                  spamFolderId={getSpamFolderId?.(m) ?? spamFolderId}
                  archiveFolderId={getArchiveFolderId?.(m) ?? archiveFolderId}
                  inboxFolderId={getInboxFolderId?.(m)}
                  folderRole={folderRole}
                  selectionIds={item.ids}
                  threadCount={item.messages.length}
                  threadUnreadCount={item.unreadCount}
                />
              </div>
            );
          })}
        </div>
        {(isFetchingMore || !hasMore) && (
          <div className="px-4 py-3 text-center text-label-13"
            style={{ color: "var(--geist-secondary)" }}
          >
            {isFetchingMore
              ? t("common.loadingMore")
              : t("common.noMore")}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "h-7 w-7 flex items-center justify-center rounded transition-colors",
        disabled && "opacity-50 cursor-default",
      )}
      style={{
        color: danger ? "var(--geist-red-500)" : "var(--geist-secondary)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--mailgo-sidebar-hover)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
    >
      <Icon size={14} />
    </button>
  );
}

function dedupeMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const message of messages) {
    const key = message.message_id?.trim().toLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(message);
  }
  return out;
}

function groupMessages(messages: Message[]): MessageListItem[] {
  const groups = new Map<string, Message[]>();
  const seenInGroup = new Map<string, Set<string>>();
  for (const message of messages) {
    const key = sharedConversationKey(message);
    const dedupeKey = message.message_id?.trim().toLowerCase();
    if (dedupeKey) {
      const seen = seenInGroup.get(key) ?? new Set<string>();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      seenInGroup.set(key, seen);
    }
    const list = groups.get(key) ?? [];
    list.push(message);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const sorted = [...group].sort(
        (a, b) => sharedMessageTime(b) - sharedMessageTime(a),
      );
      const latest = sorted[0];
      return {
        key,
        message: latest,
        messages: sorted,
        ids: sorted.map((message) => message.id),
        unreadCount: sorted.filter((message) => !message.is_read).length,
      };
    })
    .sort((a, b) => sharedMessageTime(b.message) - sharedMessageTime(a.message));
}

function conversationKey(message: Message): string {
  const subject = normalizeThreadSubject(message.subject);
  if (subject.length > 2) return `subject:${message.account_id}:${subject}`;

  const threadId = message.thread_id?.trim();
  if (threadId) return `thread:${message.account_id}:${threadId}`;

  return `message:${message.id}`;
}

function normalizeThreadSubject(subject: string | undefined | null): string {
  if (!subject) return "";
  let next = subject.trim().toLowerCase();
  let previous = "";
  while (next && next !== previous) {
    previous = next;
    next = next
      .replace(/^\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*/i, "")
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .replace(/^\s*(回复|答复|转发)\s*[:：]\s*/i, "")
      .trim();
  }
  return next.replace(/\s+/g, " ");
}

function messageTime(message: Message): number {
  const value = Date.parse(message.received_at || message.sent_at || "");
  return Number.isFinite(value) ? value : 0;
}
