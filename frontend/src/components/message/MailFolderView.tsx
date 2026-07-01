import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Star,
  Inbox,
  MailOpen,
  ArrowLeft,
  FileEdit,
  Pencil,
  Clock,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useInfiniteMessagesQuery, useMessagesQuery } from "@/hooks/queries/useMessages";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import { useFoldersForAccountsQuery } from "@/hooks/queries/useFolders";
import { useDraftsQuery } from "@/hooks/queries/useDrafts";
import { useDeleteDraft } from "@/hooks/mutations/useDraftMutations";
import { MessageList } from "@/components/message/MessageList";
import { MessageDetail } from "@/components/message/MessageDetail";
import { useIsMobile, useBreakpoint } from "@/hooks/useBreakpoint";
import {
  assignAccountColors,
  getAccountLabel,
} from "@/lib/accountColors";
import { folderIconFor } from "@/lib/folderIcons";
import { conversationKey } from "@/lib/conversation";
import { formatDateTime, safeJSON, cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Tooltip } from "@/components/ui/Tooltip";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { draftsApi, type Message, type Draft } from "@/lib/api";

/** Shared localStorage key — all folder views use the same list width. */
const SPLIT_WIDTH_KEY = "mailgo-list-width";
const DEFAULT_LIST_WIDTH = 520;
const MIN_LIST_WIDTH = 320;
const MIN_DETAIL_WIDTH = 360;

interface MailFolderViewProps {
  /** true = 星标视图；false/undefined = 文件夹角色视图（从 store 读 activeFolderRole） */
  starred?: boolean;
  /** true = 全部邮件视图（跨所有账号、所有文件夹） */
  allMail?: boolean;
  /** true = 未读邮件视图（跨所有账号） */
  unread?: boolean;
  /** true = 草稿箱视图（合并本地草稿 + IMAP 草稿） */
  drafts?: boolean;
}

/**
 * Unified template for all email folder views (收件箱/已发送/垃圾邮件/废件箱/归档/星标).
 *
 * Encapsulates the resizable split-pane layout, toolbar (icon + title + count +
 * search + batch + sync), MessageList, MessageDetail, and PreviewPlaceholder.
 * The divider width is shared across all views via a single localStorage key.
 */
export function MailFolderView({
  starred = false,
  allMail = false,
  unread = false,
  drafts = false,
}: MailFolderViewProps) {
  const { t } = useTranslation();
  const activeFolderId = useAppStore((s) => s.activeFolderId);
  const activeFolderRole = useAppStore((s) => s.activeFolderRole);
  const activeAccountId = useAppStore((s) => s.activeAccountId);
  const setSelectedMessageId = useAppStore((s) => s.setSelectedMessageId);
  const selectedMessageId = useAppStore((s) => s.selectedMessageId);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const messageFilters = useAppStore((s) => s.messageFilters);
  const conversationViewEnabled = useAppStore((s) => s.conversationViewEnabled);
  const isMobile = useIsMobile();
  const breakpoint = useBreakpoint();

  const { data: accounts = [] } = useAccountsQuery();
  const folderAccountIds = useMemo(
    () => (activeAccountId ? [activeAccountId] : accounts.map((a) => a.id)),
    [accounts, activeAccountId],
  );
  const { data: folders = [] } = useFoldersForAccountsQuery(folderAccountIds);

  const activeFolder = useMemo(
    () => folders.find((f) => f.id === activeFolderId),
    [folders, activeFolderId],
  );

  // Resolve folder role / title
  const folderRole = starred
    ? "starred"
    : unread
      ? "unread"
      : allMail
      ? "all_mail"
      : drafts
        ? "drafts"
        : (activeFolder?.role ?? activeFolderRole ?? "inbox");
  const folderTitle = starred
    ? t("starred.title")
    : unread
      ? t("sidebar.unread")
    : allMail
      ? t("sidebar.allMail")
    : drafts
      ? t("sidebar.drafts")
      : folderRole &&
          ["inbox", "sent", "drafts", "trash", "archive", "spam"].includes(
            folderRole,
          )
        ? t(`sidebar.${folderRole}`)
        : (activeFolder?.name ?? t("sidebar.inbox"));

  const folderByAccountAndRole = useMemo(() => {
    const map = new Map<string, number>();
    for (const folder of folders) {
      map.set(`${folder.account_id}:${folder.role}`, folder.id);
    }
    return map;
  }, [folders]);

  const getFolderId = (msg: Message, role: string) =>
    folderByAccountAndRole.get(`${msg.account_id}:${role}`);

  // Messages query — different params for starred / allMail / folder role.
  // Uses an infinite query so the list can grow as the user scrolls down
  // (the backend paginates with page/page_size and returns `total`).
  const filterParams = {
    has_attachment: messageFilters.hasAttachment || undefined,
    from: messageFilters.from || undefined,
    subject: messageFilters.subject || undefined,
    after: messageFilters.dateAfter || undefined,
    before: messageFilters.dateBefore || undefined,
  };
  const messageParams = starred
    ? {
        starred: true as const,
        account_id: activeAccountId ?? undefined,
        q: searchQuery || undefined,
        page_size: 50,
        ...filterParams,
      }
    : allMail
      ? {
          // No folder_id / folder_role / account_id → backend returns
          // every non-deleted, non-draft message across all accounts.
          // Exclude spam and trash from "All Mail" view.
          exclude_spam_trash: true as const,
          q: searchQuery || undefined,
          page_size: 50,
          ...filterParams,
        }
      : unread
        ? {
            unread: true as const,
            account_id: activeAccountId ?? undefined,
            q: searchQuery || undefined,
            page_size: 50,
            ...filterParams,
          }
      : drafts
        ? undefined // handled separately below
        : {
            folder_id: activeFolderId ?? undefined,
            folder_role: activeFolderId ? undefined : (activeFolderRole ?? "inbox"),
            account_id: activeAccountId ?? undefined,
            q: searchQuery || undefined,
            page_size: 50,
            ...filterParams,
          };

  const {
    data: infiniteData,
    isLoading,
    isFetching,
    error: messagesError,
    refetch: refetchMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteMessagesQuery(drafts ? undefined : messageParams, !drafts);

  // ── Drafts mode: merge local drafts + IMAP-synced drafts ──
  const showTrashedDrafts = folderRole === "trash";
  const { data: localDrafts = [], isLoading: draftsLoading } = useDraftsQuery(
    showTrashedDrafts,
    drafts || showTrashedDrafts,
  );
  const { data: imapDraftsResp, isLoading: imapDraftsLoading, isFetching: imapDraftsFetching } =
    useMessagesQuery(
      drafts
        ? {
            include_drafts: true,
            folder_role: "drafts",
            account_id: activeAccountId ?? undefined,
            page: 1,
            page_size: 100,
          }
        : undefined,
    );

  const messages = useMemo(() => {
    if (!drafts && !showTrashedDrafts) {
      return infiniteData?.pages.flatMap((p) => p.messages) ?? [];
    }
    // Merge local drafts into either Drafts or Trash.
    const remoteMessages = drafts
      ? (imapDraftsResp?.messages ?? [])
      : (infiniteData?.pages.flatMap((p) => p.messages) ?? []);
    const converted: Message[] = localDrafts
      .filter((d) => !activeAccountId || d.account_id === activeAccountId)
      .map((d) => localDraftToMessage(d));
    const all = [...remoteMessages, ...converted];
    all.sort(
      (a, b) =>
        new Date(b.received_at || b.updated_at).getTime() -
        new Date(a.received_at || a.updated_at).getTime(),
    );
    return all;
  }, [drafts, showTrashedDrafts, infiniteData, imapDraftsResp, localDrafts, activeAccountId]);

  const totalCount = drafts
    ? messages.length
    : (infiniteData?.pages[0]?.total ?? 0) +
      (showTrashedDrafts
        ? localDrafts.filter((d) => !activeAccountId || d.account_id === activeAccountId).length
        : 0);
  const isLoadingData = drafts
    ? draftsLoading || imapDraftsLoading
    : isLoading || (showTrashedDrafts && draftsLoading);
  const isFetchingData = drafts ? imapDraftsFetching : isFetching;

  const [selectedLocalDraftId, setSelectedLocalDraftId] = useState<number | null>(null);
  const accountColors = useMemo(
    () => assignAccountColors(accounts),
    [accounts],
  );

  const showAccountColor = !activeAccountId && accounts.length > 1;

  const colorFor = (msg: Message) => {
    return accountColors.get(msg.account_id);
  };
  const labelFor = (msg: Message) => {
    if (!showAccountColor) return undefined;
    return getAccountLabel(
      accounts.find((a) => a.id === msg.account_id),
      msg.account_id,
    );
  };

  const [localSearch, setLocalSearch] = useState(searchQuery);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [activeThreadKey, setActiveThreadKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SPLIT_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_LIST_WIDTH;
  });

  const EmptyIcon = unread
    ? MailOpen
    : allMail
      ? Inbox
      : drafts
        ? FileEdit
        : folderIconFor(folderRole);

  const threadMessages = useMemo(
    () =>
      activeThreadKey
        ? dedupeMessages(
            messages.filter((message) => conversationKey(message) === activeThreadKey),
          )
        : [],
    [activeThreadKey, messages],
  );
  const activeThreadSubject =
    threadMessages[0]?.subject || messages.find((m) => m.id === activeThreadId)?.subject || folderTitle;

  useEffect(() => {
    setActiveThreadId(null);
    setActiveThreadKey(null);
    setSelectedLocalDraftId(null);
  }, [activeFolderId, activeFolderRole, activeAccountId, starred, allMail, unread, drafts, searchQuery]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const max = Math.max(MIN_LIST_WIDTH, rect.width - MIN_DETAIL_WIDTH);
      const next = Math.min(
        max,
        Math.max(MIN_LIST_WIDTH, moveEvent.clientX - rect.left),
      );
      setListWidth(next);
    };
    const onUp = (upEvent: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const rect = container.getBoundingClientRect();
      const max = Math.max(MIN_LIST_WIDTH, rect.width - MIN_DETAIL_WIDTH);
      const next = Math.min(
        max,
        Math.max(MIN_LIST_WIDTH, upEvent.clientX - rect.left),
      );
      localStorage.setItem(SPLIT_WIDTH_KEY, String(Math.round(next)));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const showDetail = isMobile && (selectedMessageId || selectedLocalDraftId);
  const showList = !isMobile || !showDetail;

  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      {/* List pane — hidden on mobile when viewing a message */}
      {showList && (
      <div
        className="flex flex-col h-full border-r min-w-0"
        style={{
          width: isMobile ? "100%" : listWidth,
          minWidth: isMobile ? 0 : breakpoint === "tablet" ? 280 : 320,
          borderColor: "var(--geist-border)",
        }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 h-12 border-b shrink-0"
          style={{
            backgroundColor: "var(--geist-bg-100)",
            borderColor: "var(--geist-border)",
          }}
        >
          {activeThreadId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setActiveThreadId(null);
                  setActiveThreadKey(null);
                  setSelectedMessageId(null);
                }}
                className="h-8 w-8 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--mailgo-sidebar-hover)] hover:text-[var(--geist-primary)]"
                aria-label={t("common.back")}
                title={t("common.back")}
              >
                <ArrowLeft size={15} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-label-14 font-semibold truncate" style={{ color: "var(--geist-primary)" }}>
                  {activeThreadSubject || t("inbox.noSubject")}
                </div>
                <div className="text-label-12 text-secondary">
                  {t("mailFolder.threadCount", { count: threadMessages.length })}
                </div>
              </div>
            </>
          ) : (
            <>
              <span
                className="inline-flex items-center gap-1.5 text-label-14 font-semibold mr-1"
                style={{ color: "var(--geist-primary)" }}
              >
                {starred ? (
                  <Star size={15} fill="#f59e0b" color="#f59e0b" />
                ) : unread ? (
                  <MailOpen size={15} />
                ) : allMail ? (
                  <Inbox size={15} />
                ) : (
                  (() => {
                    const Icon = folderIconFor(folderRole);
                    return <Icon size={15} />;
                  })()
                )}
                {folderTitle}
              </span>
              <span className="text-label-12 text-secondary mr-2">
                {formatCount(totalCount)}
              </span>
              <div className="flex-1 max-w-[260px] ml-auto">
                <div className="relative">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-secondary pointer-events-none"
                  />
                  <input
                    value={localSearch}
                    onChange={(e) => {
                      setLocalSearch(e.target.value);
                      setSearchQuery(e.target.value);
                    }}
                    placeholder={t("search.placeholder")}
                    className="input-small w-full"
                    style={{ paddingLeft: 30 }}
                  />
                </div>
              </div>
              <FilterPopover />
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          <MessageList
            messages={activeThreadId ? threadMessages : messages}
            loading={isLoadingData}
            error={messages.length === 0 ? messagesError : null}
            onRetry={() => void refetchMessages()}
            onSelectMessage={(id) => {
              if (id >= LOCAL_DRAFT_ID_BASE) {
                setSelectedLocalDraftId(id - LOCAL_DRAFT_ID_BASE);
                setSelectedMessageId(null);
              } else {
                setSelectedLocalDraftId(null);
                setSelectedMessageId(selectedMessageId === id ? null : id);
              }
            }}
            onOpenThread={(thread) => {
              setActiveThreadId(thread.id);
              setActiveThreadKey(thread.key);
              setSelectedMessageId(null);
              setSelectedLocalDraftId(null);
            }}
            accountColor={colorFor}
            accountLabel={labelFor}
            getSpamFolderId={(msg) =>
              starred ? undefined : getFolderId(msg, "spam")
            }
            getArchiveFolderId={(msg) =>
              starred ? undefined : getFolderId(msg, "archive")
            }
            getInboxFolderId={(msg) =>
              starred ? undefined : getFolderId(msg, "inbox")
            }
            folderRole={folderRole}
            emptyIcon={<EmptyIcon size={22} />}
            disableConversationGrouping={!!activeThreadId}
            hasMore={hasNextPage}
            onLoadMore={() => void fetchNextPage()}
            isFetchingMore={isFetchingNextPage}
          />
        </div>
        {isFetchingData && !isLoadingData && (
          <div className="h-0.5 w-full overflow-hidden">
            <div
              className="h-full animate-pulse"
              style={{ backgroundColor: "var(--geist-tertiary)" }}
            />
          </div>
        )}
      </div>
      )}

      {/* Divider — hidden on mobile */}
      {!isMobile && (
      <div
        role="separator"
        aria-orientation="vertical"
        title={t("mailFolder.resizeHandle")}
        onPointerDown={startResize}
        className="w-1.5 -ml-[3px] -mr-[3px] cursor-col-resize shrink-0 z-10 hover:bg-[var(--geist-primary)] transition-colors"
      />
      )}

      {/* Detail pane — full-width on mobile when a message is selected */}
      {(!isMobile || showDetail) && (
      <div className={cn("h-full", isMobile ? "flex-1 min-w-0" : "flex-1 min-w-0")} style={isMobile ? {} : { minWidth: breakpoint === "tablet" ? 280 : 360 }}>
        {selectedLocalDraftId ? (
          <LocalDraftPreview
            draftId={selectedLocalDraftId}
            accounts={accounts}
            inTrash={showTrashedDrafts}
            onDelete={() => setSelectedLocalDraftId(null)}
          />
        ) : selectedMessageId ? (
          <MessageDetail
            messageId={selectedMessageId}
            onBack={() => setSelectedMessageId(null)}
            showThread={conversationViewEnabled && !activeThreadId}
          />
        ) : (
          <PreviewPlaceholder
            icon={
              starred ? (
                <Star size={28} fill="#f59e0b" color="#f59e0b" />
              ) : unread ? (
                <MailOpen size={28} />
              ) : allMail ? (
                <Inbox size={28} />
              ) : drafts ? (
                <FileEdit size={28} />
              ) : (
                <EmptyIcon size={28} />
              )
            }
            title={folderTitle}
          />
        )}
      </div>
      )}
    </div>
  );
}

/** Compact number formatting: 1878 → "1.87k", 18780 → "1.87w", 1878000 → "1.87M" */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(2).replace(/\.?0+$/, "") + "k";
  if (n < 1_000_000) return (n / 10_000).toFixed(2).replace(/\.?0+$/, "") + "w";
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
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

/** Synthetic ID base for local drafts displayed in the message list. */
const LOCAL_DRAFT_ID_BASE = 1_000_000_000;

/** Convert a local Draft (from the `drafts` table) to the Message shape so
 *  it can be rendered by the shared `MessageList` / `MessageItem` components. */
function localDraftToMessage(d: Draft): Message {
  return {
    id: LOCAL_DRAFT_ID_BASE + d.id,
    account_id: d.account_id ?? 0,
    folder_id: 0,
    uid: 0,
    message_id: "",
    subject: d.subject,
    from_address: "",
    from_name: "",
    to_addresses: d.to_addresses,
    cc_addresses: d.cc_addresses,
    bcc_addresses: d.bcc_addresses,
    reply_to: "",
    body_text: d.body_text,
    body_html: d.body_html,
    snippet: d.body_text
      ? d.body_text.replace(/\s+/g, " ").trim().slice(0, 160)
      : "",
    received_at: d.updated_at,
    sent_at: d.updated_at,
    size: 0,
    is_read: true,
    is_starred: false,
    is_answered: false,
    is_forwarded: false,
    is_draft: true,
    is_deleted: false,
    has_attachments: false,
    labels: "[]",
    thread_id: "",
    in_reply_to: d.in_reply_to ?? "",
    references: d.references ?? "",
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/* ---------- Local draft preview (read-only with Edit button) ---------- */

function LocalDraftPreview({
  draftId,
  accounts,
  inTrash,
  onDelete,
}: {
  draftId: number;
  accounts: { id: number; name: string; email: string }[];
  inTrash: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const openDraft = useAppStore((s) => s.openDraft);
  const { data: allDrafts = [] } = useDraftsQuery(inTrash);
  const deleteDraft = useDeleteDraft();
  const draft = allDrafts.find((d) => d.id === draftId);

  if (!draft) {
    return (
      <div className="h-full flex items-center justify-center text-secondary text-label-13">
        {t("mailFolder.draftNotFound")}
      </div>
    );
  }

  const account = draft.account_id
    ? accounts.find((a) => a.id === draft.account_id)
    : null;
  const toList = addressListToSummary(draft.to_addresses);
  const ccList = addressListToSummary(draft.cc_addresses);

  const handleDelete = async () => {
    if (!confirm(t("drafts.confirmDelete"))) return;
    try {
      if (inTrash) {
        await draftsApi.permanentDelete(draftId);
      } else {
        await deleteDraft.mutateAsync(draftId);
      }
      void qc.invalidateQueries({ queryKey: ["drafts"] });
      onDelete();
    } catch {
      /* toast from mutation */
    }
  };

  const handleRestore = async () => {
    await draftsApi.restore(draftId);
    void qc.invalidateQueries({ queryKey: ["drafts"] });
    onDelete();
  };

  return (
    <div
      className="flex flex-col h-full"
      style={{ backgroundColor: "var(--geist-bg-100)" }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-4 h-12 border-b shrink-0"
        style={{ borderColor: "var(--geist-border)" }}
      >
        <div className="flex-1" />
        {inTrash && (
          <Tooltip content={t("messageActions.restore")}>
            <Button
              size="small"
              variant="secondary"
              leadingIcon={<RotateCcw size={14} />}
              onClick={() => void handleRestore()}
            >
              {t("messageActions.restore")}
            </Button>
          </Tooltip>
        )}
        <Tooltip content={t("mailFolder.deleteDraft")}>
          <Button
            size="small"
            variant="secondary"
            leadingIcon={<Trash2 size={14} />}
            onClick={handleDelete}
          >
            {t("common.delete")}
          </Button>
        </Tooltip>
        <Tooltip content={t("mailFolder.editDraft")}>
          <Button
            size="small"
            variant="secondary"
            leadingIcon={<Pencil size={14} />}
            disabled={inTrash}
            onClick={() => openDraft(draftId)}
          >
            {t("common.edit")}
          </Button>
        </Tooltip>
      </div>

      {/* Subject + meta */}
      <div className="px-4 sm:px-8 pt-4 sm:pt-6 pb-4">
        <h1 className="text-heading-24 mb-4">
          {draft.subject || t("inbox.noSubject")}
        </h1>
        <div className="flex items-start gap-3">
          <Avatar
            name={account?.name ?? ""}
            email={account?.email ?? ""}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-label-14 font-semibold" style={{ color: "var(--geist-primary)" }}>
                {account ? account.name : "—"}
              </span>
              {account && (
                <span className="text-label-13 text-secondary">
                  &lt;{account.email}&gt;
                </span>
              )}
              <span
                className="text-label-12 px-1.5 h-4 inline-flex items-center rounded-full"
                style={{
                  backgroundColor: "var(--geist-amber-100)",
                  color: "var(--geist-amber-500)",
                }}
              >
                {t("mailFolder.draft")}
              </span>
            </div>
            <div className="text-label-13 text-secondary mt-1">
              {t("mailFolder.recipient", { value: toList || "—" })}
            </div>
            {ccList && (
              <div className="text-label-13 text-secondary">
                {t("mailFolder.cc", { value: ccList })}
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-1 text-label-12 text-secondary">
              <Clock size={12} />
              {formatDateTime(draft.updated_at)}
            </div>
          </div>
        </div>
      </div>

      <div className="divider mx-8" />

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 scroll-region mail-body-surface">
        {draft.body_html ? (
          <div
            className="mail-body prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: draft.body_html }}
          />
        ) : draft.body_text ? (
          <pre className="whitespace-pre-wrap text-label-14 font-sans" style={{ color: "var(--geist-primary)" }}>
            {draft.body_text}
          </pre>
        ) : (
          <p className="text-secondary text-label-13">{t("mailFolder.emptyDraft")}</p>
        )}
      </div>
    </div>
  );
}

function addressListToSummary(raw: string): string {
  if (!raw || raw === "[]") return "";
  const arr = safeJSON<Array<{ name?: string; address: string }>>(raw, []);
  if (arr.length === 0) return "";
  return arr.map((a) => a.name || a.address).join(", ");
}

function PreviewPlaceholder({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="h-full flex items-center justify-center px-8 text-center">
      <div className="max-w-[320px] flex flex-col items-center gap-3 text-secondary">
        <div
          className="h-14 w-14 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: "var(--geist-gray-100)",
            color: "var(--geist-gray-500)",
          }}
        >
          {icon}
        </div>
        <p
          className="text-label-14 font-medium"
          style={{ color: "var(--geist-primary)" }}
        >
          {title}
        </p>
        <p className="text-copy-13">{t("mailFolder.selectMessageHint")}</p>
      </div>
    </div>
  );
}
