import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Paperclip,
  Archive,
  RotateCcw,
  ShieldAlert,
  MailOpen,
  Mail,
  Trash2,
  Bot,
} from "lucide-react";
import type { Message } from "@/lib/api";
import { draftsApi } from "@/lib/api";

const LOCAL_DRAFT_ID_BASE = 1_000_000_000;
import { useAppStore } from "@/stores/appStore";
import { cn, formatDate, safeJSON } from "@/lib/utils";
import { useStarMessage, useToggleRead, useMoveMessage, useDeleteMessage, useRestoreMessage, usePermanentDeleteMessage } from "@/hooks/mutations/useMessageMutations";
import { showToast } from "@/stores/toast.store";
import { useAIMiniChatStore } from "@/stores/aiMiniChat.store";
import {
  ContextMenu,
  MenuItem,
  MenuDivider,
  useContextMenu,
} from "@/components/ui/ContextMenu";
import { Avatar } from "@/components/ui/Avatar";

interface MessageItemProps {
  message: Message;
  isSelected: boolean;
  onSelect: () => void;
  accountColor?: string;
  accountLabel?: string;
  spamFolderId?: number;
  archiveFolderId?: number;
  inboxFolderId?: number;
  folderRole?: string;
  selectionIds?: number[];
  threadCount?: number;
  threadUnreadCount?: number;
}

function parseAddress(addr: string): { name: string; address: string } {
  if (!addr) return { name: "", address: "" };
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(addr.trim());
  if (m) return { name: (m[1] || "").trim(), address: m[2].trim() };
  return { name: "", address: addr.trim() };
}

function recipientLabel(toAddresses: string): string {
  const list = safeJSON<Array<{ name?: string; address: string }>>(toAddresses, []);
  if (!Array.isArray(list) || list.length === 0) return "";
  return list
    .map((a) => (a.name && a.name.trim()) || a.address)
    .filter(Boolean)
    .join(", ");
}

function MessageItemComponent({
  message,
  isSelected,
  onSelect,
  accountColor,
  accountLabel,
  spamFolderId,
  archiveFolderId,
  inboxFolderId,
  folderRole,
  selectionIds,
  threadCount = 1,
  threadUnreadCount = 0,
}: MessageItemProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const selectedIds = useAppStore((s) => s.selectedMessageIds);
  const selectAllMessages = useAppStore((s) => s.selectAllMessages);
  const { open: openMenu } = useContextMenu();
  // Stable id tying this row's <ContextMenu> to its open() call so only
  // the right-clicked row shows a menu (not every row in the virtual list).
  const menuId = `msg-${message.id}`;


  const starMutation = useStarMessage();
  const readMutation = useToggleRead();
  const moveMutation = useMoveMessage();
  const deleteMutation = useDeleteMessage();
  const restoreMutation = useRestoreMessage();
  const permanentDeleteMutation = usePermanentDeleteMessage();
  const openMiniChat = useAIMiniChatStore((s) => s.openMiniChat);

  const isUnread = !message.is_read;
  const inArchive = folderRole === "archive";
  const inTrash = folderRole === "trash";
  const rowSelectionIds = selectionIds?.length ? selectionIds : [message.id];
  const allRowSelected = rowSelectionIds.every((id) => selectedIds.has(id));

  const fromName = parseAddress(
    message.from_name
      ? `${message.from_name} <${message.from_address}>`
      : message.from_address,
  ).name || message.from_name || message.from_address;

  const toList = safeJSON<Array<{ name?: string; address: string }>>(
    message.to_addresses,
    [],
  );

  const primaryContact =
    folderRole === "sent" && toList.length > 0
      ? recipientLabel(message.to_addresses)
      : fromName;

  const onStar = (e: React.MouseEvent) => {
    e.stopPropagation();
    starMutation.mutate(message.id);
  };

  const onToggleRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    readMutation.mutate(message.id);
  };

  const toggleRowSelection = () => {
    const next = new Set(selectedIds);
    if (allRowSelected) {
      rowSelectionIds.forEach((id) => next.delete(id));
    } else {
      rowSelectionIds.forEach((id) => next.add(id));
    }
    selectAllMessages(Array.from(next));
  };

  const onArchive = () => {
    const targetFolderId = inArchive ? inboxFolderId : archiveFolderId;
    if (!targetFolderId) {
      showToast(
        inArchive ? "Inbox folder not found" : "Archive folder not found",
        "error",
      );
      return;
    }
    moveMutation.mutate({ id: message.id, folderId: targetFolderId });
  };

  const onSpam = () => {
    if (!spamFolderId) {
      showToast(t("messageDetail.spamFolderNotFound"), "error");
      return;
    }
    moveMutation.mutate({ id: message.id, folderId: spamFolderId });
  };

  // AI assistant: if there are multiple messages selected (via checkboxes
  // or drag-select), attach all of them as context. Otherwise just use the
  // right-clicked message.
  const onAIAssistant = async () => {
    const ids =
      selectedIds.size > 0 ? Array.from(selectedIds) : rowSelectionIds;
    showToast(t("ai.attachedEmails", { count: ids.length }), "info");
    openMiniChat({
      label: t("ai.selectedCount", { count: ids.length }),
      contextText: `${t("ai.contextPrefix")}${ids.join(", ")}${t("ai.contextSuffix")}`,
    });
  };


  return (
    <>
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, menuId);
      }}
      className={cn(
        "relative flex flex-col gap-1 px-4 py-2.5 cursor-pointer transition-colors border-b",
        "h-[68px] sm:h-[88px] overflow-hidden",
      )}
      style={{
        borderColor: "var(--geist-border)",
        backgroundColor: isSelected
          ? "var(--mailgo-sidebar-active)"
          : undefined,
        color: "var(--geist-primary)",
        fontWeight: isUnread ? 600 : 400,
      }}
    >
      {accountColor && (
        <span
          aria-label={accountLabel}
          title={accountLabel}
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: 5,
            borderRadius: "0 3px 3px 0",
            background: `repeating-linear-gradient(-45deg, ${accountColor}, ${accountColor} 2px, #fff 2px, #fff 4px)`,
          }}
        />
      )}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <input
            type="checkbox"
            checked={allRowSelected}
            onChange={toggleRowSelection}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("batch.selectMessage")}
            className="h-4 w-4 rounded accent-[var(--geist-primary)] shrink-0"
          />
          <Avatar
            name={message.from_name}
            email={message.from_address}
            size={28}
          />
          <span className="truncate text-label-14 flex-1 min-w-0">
            {primaryContact || t("inbox.noSubject")}
          </span>
          {isUnread && (
            <span
              className="shrink-0 rounded-full"
              style={{
                width: 6,
                height: 6,
                background: "var(--geist-tertiary)",
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {message.is_starred && (
            <Star size={13} fill="#f59e0b" color="#f59e0b" />
          )}
          {message.has_attachments && (
            <Paperclip
              size={13}
              className="text-secondary"
              aria-label={t("messageDetail.hasAttachments")}
            />
          )}
          {threadCount > 1 && (
            <span
              className="text-label-11 tabular-nums rounded-full px-1.5 h-5 inline-flex items-center"
              style={{
                color: "var(--geist-primary)",
                backgroundColor: "var(--geist-bg-200)",
              }}
              title={`${threadCount} messages`}
            >
              {threadUnreadCount > 0
                ? `${threadUnreadCount}/${threadCount}`
                : threadCount}
            </span>
          )}
          <span className="text-label-12 text-secondary">
            {formatDate(message.received_at)}
          </span>
        </div>
      </div>
      <div
        className="text-label-14"
        style={{
          color: "var(--geist-primary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {message.subject || t("inbox.noSubject")}
      </div>
      <div
        className="text-label-13 text-secondary hidden sm:block"
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {normalizePreview(message.snippet)}
      </div>
    </div>

    <ContextMenu menuId={menuId}>
      <MenuItem
        icon={<Star size={14} fill={message.is_starred ? "#f59e0b" : "none"} color={message.is_starred ? "#f59e0b" : "currentColor"} />}
        label={message.is_starred ? t("messageActions.unstar") : t("messageActions.star")}
        onClick={() => starMutation.mutate(message.id)}
      />
      <MenuItem
        icon={isUnread ? <Mail size={14} /> : <MailOpen size={14} />}
        label={isUnread ? t("messageActions.markRead") : t("messageActions.markUnread")}
        onClick={() => readMutation.mutate(message.id)}
      />
      <MenuDivider />
      <MenuItem
        icon={<Bot size={14} />}
        label={
          selectedIds.size > 1
            ? `${t("ai.assistant")} (${selectedIds.size})`
            : threadCount > 1
              ? `${t("ai.assistant")} (${threadCount})`
              : t("ai.assistant")
        }
        onClick={onAIAssistant}
      />
      {inTrash ? (
        <>
          <MenuItem
            icon={<RotateCcw size={14} />}
            label={t("messageActions.restore", "Restore")}
            onClick={async () => {
              if (message.id >= LOCAL_DRAFT_ID_BASE) {
                await draftsApi.restore(message.id - LOCAL_DRAFT_ID_BASE);
                qc.invalidateQueries({ queryKey: ["drafts"] });
              } else {
                restoreMutation.mutate(message.id);
              }
            }}
          />
          <MenuItem
            icon={<Trash2 size={14} />}
            label={t("messageActions.deleteForever", "Delete forever")}
            onClick={async () => {
              if (message.id >= LOCAL_DRAFT_ID_BASE) {
                await draftsApi.permanentDelete(message.id - LOCAL_DRAFT_ID_BASE);
                qc.invalidateQueries({ queryKey: ["drafts"] });
              } else {
                permanentDeleteMutation.mutate(message.id);
              }
            }}
            danger
          />
        </>
      ) : (
        <>
          <MenuItem
        icon={inArchive ? <RotateCcw size={14} /> : <Archive size={14} />}
        label={inArchive ? t("messageActions.unarchive") : t("messageActions.archive")}
        onClick={onArchive}
        disabled={inArchive ? !inboxFolderId : !archiveFolderId}
      />
          {spamFolderId && !inArchive && (
            <MenuItem
              icon={<ShieldAlert size={14} />}
              label={t("messageActions.reportSpam")}
              onClick={onSpam}
            />
          )}
          <MenuItem
            icon={<Trash2 size={14} />}
            label={t("common.delete")}
            onClick={async () => {
              if (message.id >= LOCAL_DRAFT_ID_BASE) {
                await draftsApi.delete(message.id - LOCAL_DRAFT_ID_BASE);
                qc.invalidateQueries({ queryKey: ["drafts"] });
              } else {
                deleteMutation.mutate(message.id);
              }
            }}
            danger
          />
        </>
      )}
    </ContextMenu>
    </>
  );
}

export const MessageItem = memo(MessageItemComponent);

/** Collapse newlines and runs of whitespace into single spaces so the
 *  truncated preview doesn't show a gap where the original had blank
 *  lines (e.g. "Dear customer,\n\n\n\nWe are pleased…"). */
function normalizePreview(s: string | undefined | null): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}
