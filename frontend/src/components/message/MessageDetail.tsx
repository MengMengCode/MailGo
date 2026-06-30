import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  RotateCcw,
  MailOpen,
  Mail,
  Clock,
  Paperclip,
  ArrowLeft,
  ShieldAlert,
  Shield,
  ImageOff,
  ImageIcon,
  Languages,
  Loader2,
  X,
  Code,
  Copy,
  ChevronDown,
  ChevronRight,
  Pencil,
} from "lucide-react";
import { useMessageQuery, useMessageThreadQuery } from "@/hooks/queries/useMessages";
import { useAppStore } from "@/stores/appStore";
import {
  useDeleteMessage,
  usePermanentDeleteMessage,
  useMoveMessage,
  useRestoreMessage,
  useStarMessage,
  useToggleRead,
} from "@/hooks/mutations/useMessageMutations";
import { useFoldersForAccountsQuery } from "@/hooks/queries/useFolders";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { showToast } from "@/stores/toast.store";
import { isAITranslateConfigured } from "@/lib/aiConfigCheck";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import { useAIMiniChatStore } from "@/stores/aiMiniChat.store";
import { Bot } from "lucide-react";
import { aiApi, apiFetch, attachmentsApi, draftsApi, messagesApi, pgpKeysApi, type Attachment, type Message } from "@/lib/api";

/** Must match the value in MailFolderView.tsx */
const LOCAL_DRAFT_ID_BASE = 1_000_000_000;
import { assignAccountColors } from "@/lib/accountColors";
import { isPGPMessage, tryDecrypt } from "@/lib/pgp";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Tooltip } from "@/components/ui/Tooltip";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime, safeJSON, cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { useIsMobile } from "@/hooks/useBreakpoint";
import { FileIcon } from "@/components/ui/FileIcon";
import { PdfPreview } from "@/components/ui/PdfPreview";
import { confirm } from "@/stores/confirm.store";

interface MessageDetailProps {
  messageId: number;
  onBack?: () => void;
  showThread?: boolean;
}

export function MessageDetail({ messageId, onBack, showThread = false }: MessageDetailProps) {
  const { t, i18n } = useTranslation();
  const openCompose = useAppStore((s) => s.openCompose);
  const openDraft = useAppStore((s) => s.openDraft);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setSelectedMessageId = useAppStore((s) => s.setSelectedMessageId);
  const activeAccountId = useAppStore((s) => s.activeAccountId);
  const { data: accounts = [] } = useAccountsQuery();
  const qc = useQueryClient();
  const { data: folders = [] } = useFoldersForAccountsQuery(
    activeAccountId ? [activeAccountId] : accounts.map((a) => a.id),
  );
  const accountColors = assignAccountColors(accounts);
  const isMobile = useIsMobile();
  const px = isMobile ? "px-4" : "px-8";

  const { data: message, isLoading } = useMessageQuery(messageId);
  const { data: threadData, isLoading: isThreadLoading } = useMessageThreadQuery(messageId);

  // PGP decryption state
  const [pgpDecrypted, setPgpDecrypted] = useState<string | null>(null);
  const [pgpDecrypting, setPgpDecrypting] = useState(false);
  const [pgpFailed, setPgpFailed] = useState(false);
  const [manualKey, setManualKey] = useState("");
  const pgpBodyText = message?.body_text || message?.body_html || "";
  const isEncrypted = isPGPMessage(pgpBodyText);

  // Auto-decrypt on message load
  useEffect(() => {
    if (!isEncrypted || !message) {
      setPgpDecrypted(null);
      setPgpFailed(false);
      setManualKey("");
      return;
    }
    let cancelled = false;
    setPgpDecrypting(true);
    setPgpFailed(false);
    setPgpDecrypted(null);

    (async () => {
      try {
        const keys = await pgpKeysApi.list();
        const ciphertext = message.body_text || message.body_html || "";
        for (const k of keys) {
          if (cancelled) return;
          try {
            const priv = await pgpKeysApi.getPrivateKey(k.id);
            if (!priv.private_key) continue;
            const plain = await tryDecrypt(ciphertext, priv.private_key);
            if (plain && !cancelled) {
              setPgpDecrypted(plain);
              setPgpDecrypting(false);
              return;
            }
          } catch {
            continue;
          }
        }
        if (!cancelled) {
          setPgpFailed(true);
          setPgpDecrypting(false);
        }
      } catch {
        if (!cancelled) {
          setPgpFailed(true);
          setPgpDecrypting(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isEncrypted, message]);

  const handleManualDecrypt = async () => {
    if (!manualKey.trim() || !message) return;
    setPgpDecrypting(true);
    const ciphertext = message.body_text || message.body_html || "";
    const plain = await tryDecrypt(ciphertext, manualKey.trim());
    if (plain) {
      setPgpDecrypted(plain);
      setPgpFailed(false);
    } else {
      showToast(t("messageDetail.decryptionFailed"), "error");
    }
    setPgpDecrypting(false);
  };

  const threadMessages = useMemo(
    () => (threadData?.messages?.length ? threadData.messages : message ? [message] : []),
    [message, threadData],
  );
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (threadMessages.length === 0) return;
    const latest = [...threadMessages].sort((a, b) => messageTime(b) - messageTime(a))[0];
    const defaults = new Set<number>([latest.id, messageId]);
    for (const item of threadMessages) {
      if (!item.is_read) defaults.add(item.id);
    }
    setExpandedThreadIds(defaults);
  }, [messageId, threadMessages]);
  // Always fetch attachments — the has_attachments flag can be stale when
  // older messages were synced before attachment detection was wired up.
  const { data: attachments = [] } = useQuery({
    queryKey: ["attachments", messageId],
    queryFn: () => attachmentsApi.list(messageId),
    enabled: !!messageId,
  });

  const starMutation = useStarMessage();
  const readMutation = useToggleRead();
  const deleteMutation = useDeleteMessage();
  const restoreMutation = useRestoreMessage();
  const permanentDeleteMutation = usePermanentDeleteMessage();
  const moveMutation = useMoveMessage();

  // Edit IMAP draft: create a local draft from the message content, then
  // open it in the compose view.
  const editDraftMutation = useMutation({
    mutationFn: async (msg: Message) => {
      const { id } = await draftsApi.create({
        account_id: msg.account_id,
        to_addresses: msg.to_addresses || "[]",
        cc_addresses: msg.cc_addresses || "[]",
        bcc_addresses: msg.bcc_addresses || "[]",
        subject: msg.subject || "",
        body_html: msg.body_html || "",
        body_text: msg.body_text || "",
      });
      return id;
    },
    onSuccess: (draftId) => {
      qc.invalidateQueries({ queryKey: ["drafts"] });
      openDraft(draftId);
    },
    onError: () => showToast(t("drafts.editFailed"), "error"),
  });

  // Remote-image blocking: like eM Client / Gmail, remote <img src="http...">
  // are hidden by default. The user can opt to load them per message.
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState(false);
  const [trackingAllowed, setTrackingAllowed] = useState(false);
  const [toExpanded, setToExpanded] = useState(false);
  const [ccExpanded, setCcExpanded] = useState(false);
  const openMiniChat = useAIMiniChatStore((s) => s.openMiniChat);
  const [bodyMenu, setBodyMenu] = useState<{ x: number; y: number } | null>(null);
  const [previewAtt, setPreviewAtt] = useState<Attachment | null>(null);
  const [rawSource, setRawSource] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [copiedRaw, setCopiedRaw] = useState(false);

  const openRawSource = async () => {
    if (rawSource !== null || rawLoading) {
      // Already loaded (or loading) — just re-open.
      setRawSource(rawSource);
      return;
    }
    setRawLoading(true);
    setRawError(null);
    try {
      const text = await messagesApi.raw(messageId);
      setRawSource(text);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : t("messageDetail.loadSourceFailed"));
    } finally {
      setRawLoading(false);
    }
  };

  // Reset the per-message "load images" choice whenever the selected
  // message changes so a freshly opened email starts blocked again.
  // Must run in an effect (not during render) to avoid the
  // "Cannot update during render" React error.
  useEffect(() => {
    setRemoteImagesAllowed(false);
    setTrackingAllowed(false);
  }, [messageId]);

  // Auto-mark as read: when a message is opened and is still unread,
  // mark it read after a short delay (like Gmail / eM Client). We track
  // the message id in a ref so a re-render (e.g. after the optimistic
  // flip) doesn't trigger the toggle a second time. The toggle is only
  // invoked when `is_read` is false, so re-opening an already-read
  // message is a no-op.
  const autoReadDoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (!message) return;
    if (message.is_read) return;
    if (autoReadDoneRef.current === message.id) return;
    autoReadDoneRef.current = message.id;
    const timer = window.setTimeout(() => {
      readMutation.mutate(message.id);
    }, 600);
    return () => window.clearTimeout(timer);
    // readMutation.mutate is referentially stable; we intentionally only
    // re-run when the message changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  // Close the body context menu on outside click / scroll / escape.
  useEffect(() => {
    if (!bodyMenu) return;
    const close = () => setBodyMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [bodyMenu]);

  const handleBodyContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) return; // let the native menu handle no-selection
    e.preventDefault();
    setBodyMenu({ x: e.clientX, y: e.clientY });
  };

  const translateSelection = async () => {
    const sel = window.getSelection()?.toString().trim();
    if (!sel) return;
    openMiniChat(
      { label: t("messageDetail.selectedText"), contextText: sel },
      `${t("messageDetail.translatePrompt")}\n\n${sel}`,
    );
  };

  const askAIAboutSelection = () => {
    const sel = window.getSelection()?.toString().trim();
    if (!sel) return;
    openMiniChat({ label: t("messageDetail.selectedText"), contextText: sel });
  };


  // All hooks must run before any early return, otherwise React throws
  // "Rendered more hooks than during the previous render" (#300) when the
  // loading state flips. The memoized values are computed from `message`
  // which may be undefined while loading — guard inside the callback.
  const htmlWithInlineAttachments = useMemo(
    () => (message ? resolveInlineImages(message.body_html, attachments) : ""),
    [message, attachments],
  );

  // --- Settings (needed by memos below) ---
  const { data: settings = [] } = useSettingsQuery();
  const autoLoadRemoteResources =
    settings.find((s) => s.key === "auto_load_remote_resources")?.value === "true";
  const preventTracking =
    settings.find((s) => s.key === "prevent_tracking")?.value !== "false";

  // Strip tracking pixels before processing remote images.
  // Runs even when remote images are allowed, so trackers stay blocked.
  const { html: htmlWithoutTrackers, count: trackerCount } = useMemo(
    () => (preventTracking && !trackingAllowed ? stripTrackingPixels(htmlWithInlineAttachments) : { html: htmlWithInlineAttachments, count: 0 }),
    [htmlWithInlineAttachments, preventTracking, trackingAllowed],
  );
  const { html: safeHtml, hasRemoteImages } = useMemo(
    () => processRemoteImages(htmlWithoutTrackers, remoteImagesAllowed),
    [htmlWithoutTrackers, remoteImagesAllowed],
  );
  const hasRemoteLinks = useMemo(
    () =>
      !!message &&
      !message.body_html &&
      !!message.body_text &&
      /https?:\/\//i.test(message.body_text),
    [message],
  );
  const showRemoteBanner = hasRemoteImages || hasRemoteLinks; // default on
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showOriginal, setShowOriginal] = useState(true);
  const safeTranslatedHtml = useMemo(
    () => {
      if (!translatedText || !message?.body_html) return "";
      return processRemoteImages(translatedText, remoteImagesAllowed).html;
    },
    [translatedText, message?.body_html, remoteImagesAllowed],
  );

  useEffect(() => {
    setRemoteImagesAllowed(autoLoadRemoteResources);
  }, [messageId, autoLoadRemoteResources]);

  // Reset translation when message changes.
  useEffect(() => {
    setTranslatedText(null);
    setTranslating(false);
    setShowOriginal(true);
  }, [messageId]);

  // Detect whether the email body is written in a different language
  // than the current UI language. We count CJK vs non-CJK letter
  // characters and compare by ratio — a few scattered CJK characters in
  // an otherwise English email (or vice versa) won't trigger the prompt.
  const needsTranslation = useMemo(() => {
    if (!message) return false;
    const text = message.body_text || stripHtml(message.body_html) || "";
    if (!text || text.length < 10) return false;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||  // CJK Unified
        (code >= 0x3040 && code <= 0x30ff) ||  // Hiragana + Katakana
        (code >= 0xac00 && code <= 0xd7af)     // Hangul
      ) {
        cjk++;
      } else if (/[a-zA-Z]/.test(ch)) {
        other++;
      }
    }
    const total = cjk + other;
    if (total < 10) return false; // not enough text to judge
    const cjkRatio = cjk / total;
    const uiIsCJK = i18n.language === "zh-CN" || i18n.language === "zh-TW" || i18n.language === "ja" || i18n.language === "ko";
    // Body is considered CJK when CJK chars make up >30% of letter chars.
    // This tolerates scattered foreign words while still catching genuinely
    // foreign-language emails.
    const bodyIsCJK = cjkRatio > 0.3;
    return (bodyIsCJK && !uiIsCJK) || (!bodyIsCJK && uiIsCJK);
  }, [message, i18n.language]);

  const handleTranslate = async () => {
    if (!message) return;
    if (!isAITranslateConfigured(settings)) {
      showToast(t("ai.notConfiguredTranslate"), "warning");
      return;
    }
    setTranslating(true);
    try {
      const targetLang = i18n.language === "zh-CN" ? "简体中文" : i18n.language === "zh-TW" ? "繁體中文" : "English";

      if (message.body_html) {
        // HTML mode: extract text nodes, translate as plain text, splice back.
        const { html: originalHtml, texts, replacements } = extractHtmlTexts(message.body_html);
        if (texts.length === 0) {
          showToast(t("messageDetail.noTranslatableText"), "error");
          setTranslating(false);
          return;
        }
        const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
        const res = await aiApi.translate({
          messages: [
            {
              role: "system",
              content: `You are a professional translator. Translate each numbered line below to ${targetLang}. Rules:\n- Return EXACTLY the same number of lines, same order.\n- Keep the "N. " prefix on each line.\n- Only translate the text after the prefix.\n- Do NOT add any explanation or extra lines.`,
            },
            { role: "user", content: numbered },
          ],
        });
        const data = await res.json();
        if (!res.ok || data.error?.message) {
          throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        const content = data.choices?.[0]?.message?.content || "";
        // Parse "N. translated text" lines.
        const translatedLines = content.split("\n").map((line: string) => {
          const m = line.match(/^\d+\.\s?(.*)/);
          return m ? m[1] : line;
        });
        // Apply translations back into the HTML.
        const translatedHtml = applyTranslations(originalHtml, replacements, translatedLines);
        setTranslatedText(translatedHtml);
      } else {
        // Plain text mode.
        const text = message.body_text || "";
        const res = await aiApi.translate({
          messages: [
            { role: "system", content: `You are a professional translator. Translate the following email to ${targetLang}. Only return the translation, preserving formatting.` },
            { role: "user", content: text },
          ],
        });
        const data = await res.json();
        if (!res.ok || data.error?.message) {
          throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        setTranslatedText(data.choices?.[0]?.message?.content || "");
      }
      setShowOriginal(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("messageDetail.translationFailed"), "error");
    } finally {
      setTranslating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div
          className="h-12 border-b"
          style={{ borderColor: "var(--geist-border)" }}
        />
        <div className="p-6 space-y-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="px-6 space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-10/12" />
        </div>
      </div>
    );
  }

  if (!message) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <p className="text-copy-13 text-disabled">{t("messageDetail.noMessage")}</p>
      </div>
    );
  }

  const toList = safeJSON<Array<{ name?: string; address: string }>>(
    message.to_addresses,
    [],
  );
  const ccList = safeJSON<Array<{ name?: string; address: string }>>(
    message.cc_addresses,
    [],
  );

  const account = accounts.find((a) => a.id === message.account_id);
  const accountColor = accountColors.get(message.account_id);

  const archiveFolder = folders.find(
    (f) => f.role === "archive" && f.account_id === message.account_id,
  );
  const spamFolder = folders.find(
    (f) => f.role === "spam" && f.account_id === message.account_id,
  );

  const fromName = message.from_name?.trim() || message.from_address;
  const visibleAttachments = attachments.filter((a) => !a.content_id);
  // Determine whether the message is in the trash folder by checking the
  // folder's role (reliable across providers) rather than its name.
  const messageFolder = folders.find((f) => f.id === message.folder_id);
  const inTrash = messageFolder?.role === "trash";

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
        {onBack && (
          <IconButton ariaLabel={t("common.back")} size="md" onClick={onBack}>
            <ArrowLeft size={15} />
          </IconButton>
        )}
        <Tooltip content={t("messageDetail.viewSource")}>
          <IconButton
            ariaLabel={t("messageDetail.viewSource")}
            onClick={() => void openRawSource()}
          >
            <Code size={15} />
          </IconButton>
        </Tooltip>
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-1 overflow-x-auto shrink-0">
        <Tooltip content={t("messageActions.reply")}>
          <IconButton
            ariaLabel={t("messageActions.reply")}
            onClick={() => openCompose("reply", message.id)}
          >
            <Reply size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t("messageActions.replyAll")}>
          <IconButton
            ariaLabel={t("messageActions.replyAll")}
            onClick={() => openCompose("reply_all", message.id)}
          >
            <ReplyAll size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t("messageActions.forward")}>
          <IconButton
            ariaLabel={t("messageActions.forward")}
            onClick={() => openCompose("forward", message.id)}
          >
            <Forward size={15} />
          </IconButton>
        </Tooltip>
        {message.is_draft && (
          <Tooltip content={t("messageActions.editDraft")}>
            <Button
              size="small"
              variant="secondary"
              leadingIcon={<Pencil size={14} />}
              loading={editDraftMutation.isPending}
              onClick={() => {
                if (message) editDraftMutation.mutate(message);
              }}
            >
              <span className="hidden sm:inline">{t("messageActions.editDraft")}</span>
            </Button>
          </Tooltip>
        )}
        <Tooltip
          content={
            message.is_starred
              ? t("messageActions.unstar")
              : t("messageActions.star")
          }
        >
          <IconButton
            ariaLabel={
              message.is_starred
                ? t("messageActions.unstar")
                : t("messageActions.star")
            }
            active={message.is_starred}
            onClick={() => starMutation.mutate(message.id)}
          >
            <Star
              size={15}
              fill={message.is_starred ? "#f59e0b" : "none"}
              color={message.is_starred ? "#f59e0b" : "currentColor"}
            />
          </IconButton>
        </Tooltip>
        <Tooltip
          content={
            message.is_read
              ? t("messageActions.markUnread")
              : t("messageActions.markRead")
          }
        >
          <IconButton
            ariaLabel={
              message.is_read
                ? t("messageActions.markUnread")
                : t("messageActions.markRead")
            }
            onClick={() => readMutation.mutate(message.id)}
          >
            {message.is_read ? <Mail size={15} /> : <MailOpen size={15} />}
          </IconButton>
        </Tooltip>
        {archiveFolder && (
          <Tooltip
            content={
              message.folder_name?.toLowerCase() === "archive"
                ? t("messageActions.unarchive")
                : t("messageActions.archive")
            }
          >
            <IconButton
              ariaLabel={t("messageActions.archive")}
              onClick={() =>
                moveMutation.mutate({
                  id: message.id,
                  folderId: archiveFolder.id,
                })
              }
            >
              {message.folder_name?.toLowerCase() === "archive" ? (
                <RotateCcw size={15} />
              ) : (
                <Archive size={15} />
              )}
            </IconButton>
          </Tooltip>
        )}
        {spamFolder && (
          <Tooltip content={t("messageActions.reportSpam")}>
            <IconButton
              ariaLabel={t("messageActions.reportSpam")}
              onClick={async () => {
                const ok = await confirm({
                  title: t("messageActions.reportSpam"),
                  description: t("messageDetail.moveToSpam"),
                  destructive: true,
                  confirmText: t("messageActions.reportSpam"),
                  confirmVariant: "error",
                });
                if (!ok) return;
                moveMutation.mutate({ id: message.id, folderId: spamFolder.id });
                setSelectedMessageId(null);
              }}
            >
              <ShieldAlert size={15} />
            </IconButton>
          </Tooltip>
        )}
        {inTrash ? (
          <>
            <Tooltip content={t("messageActions.restore", "Restore")}>
              <IconButton
                ariaLabel={t("messageActions.restore", "Restore")}
                onClick={() => restoreMutation.mutate(message.id)}
              >
                <RotateCcw size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip content={t("messageActions.deleteForever", "Delete forever")}>
              <IconButton
                ariaLabel={t("messageActions.deleteForever", "Delete forever")}
                onClick={async () => {
                  const ok = await confirm({
                    title: t("messageActions.deleteForever", "Delete forever"),
                    description: t("messageDetail.permanentDeleteDesc"),
                    destructive: true,
                    confirmText: t("common.delete"),
                    confirmVariant: "error",
                  });
                  if (!ok) return;
                  if (message.id >= LOCAL_DRAFT_ID_BASE) {
                    await draftsApi.delete(message.id - LOCAL_DRAFT_ID_BASE);
                    qc.invalidateQueries({ queryKey: ["drafts"] });
                  } else {
                    permanentDeleteMutation.mutate(message.id);
                  }
                  setSelectedMessageId(null);
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <Tooltip content={t("common.delete")}>
            <IconButton
              ariaLabel={t("common.delete")}
              onClick={async () => {
                const ok = await confirm({
                  title: t("common.delete"),
                  description: t("messageDetail.moveToTrash"),
                  destructive: true,
                  confirmText: t("common.delete"),
                  confirmVariant: "error",
                });
                if (!ok) return;
                // Local drafts use synthetic IDs — route to draftsApi.delete
                if (message.id >= LOCAL_DRAFT_ID_BASE) {
                  await draftsApi.delete(message.id - LOCAL_DRAFT_ID_BASE);
                  qc.invalidateQueries({ queryKey: ["drafts"] });
                } else {
                  deleteMutation.mutate(message.id);
                }
                setSelectedMessageId(null);
              }}
            >
              <Trash2 size={15} />
            </IconButton>
          </Tooltip>
        )}
        </div>
      </div>
      <div className={`${px} pt-6 pb-4`}>
        <h1 className="text-heading-24 mb-4">
          {message.subject || t("inbox.noSubject")}
        </h1>
        <div className="flex items-start gap-3">
          <Avatar
            name={message.from_name}
            email={message.from_address}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-label-14 font-semibold">{fromName}</span>
              <span className="text-label-13 text-secondary">
                {message.from_address}
              </span>
              {account && (
                <span
                  className="tag"
                  style={{
                    backgroundColor: accountColor
                      ? `${accountColor}22`
                      : "var(--geist-gray-100)",
                    color: accountColor ?? "var(--geist-secondary)",
                  }}
                >
                  {account.email}
                </span>
              )}
            </div>
            {toList.length > 0 && (
              <div className="text-label-13 text-secondary mt-1">
                <div
                  className="flex flex-wrap items-center gap-1"
                  style={toExpanded ? { maxHeight: 120, overflowY: "auto" } : undefined}
                >
                  <span className="text-disabled shrink-0">to </span>
                  {(toExpanded ? toList : toList.slice(0, 8)).map((a, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-geist px-2 py-px text-label-12 whitespace-nowrap"
                      style={{ backgroundColor: "#fff", border: "1px solid var(--geist-border)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--geist-foreground)" }}>
                        {a.name?.trim() || a.address}
                      </span>
                      {a.name?.trim() && a.name.trim() !== a.address && (
                        <span className="ml-1 text-disabled">{a.address}</span>
                      )}
                    </span>
                  ))}
                </div>
                {toList.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setToExpanded((v) => !v)}
                    className="text-label-12 hover:underline mt-0.5"
                    style={{ color: "var(--geist-primary)" }}
                  >
                    {toExpanded ? t("messageDetail.collapse") : t("messageDetail.plusMore", { count: toList.length - 8 })}
                  </button>
                )}
              </div>
            )}
            {ccList.length > 0 && (
              <div className="text-label-13 text-secondary mt-1">
                <div
                  className="flex flex-wrap items-center gap-1"
                  style={ccExpanded ? { maxHeight: 120, overflowY: "auto" } : undefined}
                >
                  <span className="text-disabled shrink-0">cc </span>
                  {(ccExpanded ? ccList : ccList.slice(0, 8)).map((a, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-geist px-2 py-px text-label-12 whitespace-nowrap"
                      style={{ backgroundColor: "#fff", border: "1px solid var(--geist-border)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--geist-foreground)" }}>
                        {a.name?.trim() || a.address}
                      </span>
                      {a.name?.trim() && a.name.trim() !== a.address && (
                        <span className="ml-1 text-disabled">{a.address}</span>
                      )}
                    </span>
                  ))}
                </div>
                {ccList.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setCcExpanded((v) => !v)}
                    className="text-label-12 hover:underline mt-0.5"
                    style={{ color: "var(--geist-primary)" }}
                  >
                    {ccExpanded ? t("messageDetail.collapse") : t("messageDetail.plusMore", { count: ccList.length - 8 })}
                  </button>
                )}
              </div>
            )}
            <p className="text-label-12 text-disabled mt-1 flex items-center gap-2">
              <Clock size={11} />
              {formatDateTime(message.received_at)}
            </p>
          </div>
        </div>
      </div>

      <div className={`divider ${isMobile ? "mx-4" : "mx-8"}`} />

      {/* Body */}
      <div
        className={`flex-1 overflow-y-auto ${px} py-6 scroll-region mail-body-surface`}
      >
        <div className="mail-body-invert">
        {showThread && threadMessages.length > 0 ? (
          <div className="space-y-3">
            {isThreadLoading && (
              <div className="flex items-center gap-2 text-label-13 text-secondary">
                <Loader2 size={14} className="spinner" /> {t("messageDetail.loadingThread")}
              </div>
            )}
            {threadMessages.map((item) => (
              <ThreadMessageCard
                key={item.id}
                message={item}
                expanded={expandedThreadIds.has(item.id)}
                onToggle={() =>
                  setExpandedThreadIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
                onContextMenu={handleBodyContextMenu}
                onPreviewAttachment={setPreviewAtt}
              />
            ))}
          </div>
        ) : (
          <>
        {showRemoteBanner && !remoteImagesAllowed && (
          <div
            className="flex items-center justify-between gap-3 rounded-geist border px-3 py-2 mb-4"
            style={{
              borderColor: "var(--geist-amber-200, #fcd34d)",
              backgroundColor: "var(--geist-amber-100, #fef3c7)",
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <ImageOff size={14} className="shrink-0" style={{ color: "#b45309" }} />
              <span className="text-label-13" style={{ color: "#92400e" }}>
                {t("message.remoteImagesBlocked")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRemoteImagesAllowed(true)}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-geist text-label-12 font-medium shrink-0"
              style={{
                backgroundColor: "white",
                color: "#92400e",
                border: "1px solid #fcd34d",
              }}
            >
              <ImageIcon size={12} />
              {t("message.loadImages")}
            </button>
          </div>
        )}
        {/* Tracking blocked indicator */}
        {trackerCount > 0 && (
          <div
            className="flex items-center justify-between gap-3 rounded-geist border px-3 py-2 mb-4"
            style={{
              borderColor: "var(--geist-green-200, #bbf7d0)",
              backgroundColor: "var(--geist-green-50, #f0fdf4)",
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Shield size={14} className="shrink-0" style={{ color: "#16a34a" }} />
              <span className="text-label-13" style={{ color: "#15803d" }}>
                {t("settings.trackersDetected")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setTrackingAllowed(true)}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-geist text-label-12 font-medium shrink-0"
              style={{
                backgroundColor: "white",
                color: "#15803d",
                border: "1px solid #bbf7d0",
              }}
            >
              {t("settings.allowTracking")}
            </button>
          </div>
        )}
        {/* Translation banner */}
        {needsTranslation && !translatedText && (
          <div
            className="flex items-center justify-between gap-3 rounded-geist border px-3 py-2 mb-4"
            style={{
              borderColor: "var(--geist-blue-200, #bfdbfe)",
              backgroundColor: "var(--geist-blue-50, #eff6ff)",
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Languages size={14} className="shrink-0" style={{ color: "#1d4ed8" }} />
              <span className="text-label-13" style={{ color: "#1e40af" }}>
                {t("messageDetail.languageMismatch")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleTranslate()}
              disabled={translating}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-geist text-label-12 font-medium shrink-0"
              style={{ backgroundColor: "white", color: "#1d4ed8", border: "1px solid #bfdbfe" }}
            >
              {translating ? <Loader2 size={12} className="spinner" /> : <Languages size={12} />}
              {translating ? t("messageDetail.translating") : t("messageDetail.translateEmail")}
            </button>
          </div>
        )}
        {/* Translation toggle (show original / show translation) */}
        {translatedText && (
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setShowOriginal(true)}
              className={cn(
                "h-7 px-3 rounded-geist text-label-12 border transition-colors",
                showOriginal ? "text-[var(--geist-primary)] font-medium" : "text-secondary",
              )}
              style={{
                borderColor: showOriginal ? "var(--geist-primary)" : "var(--geist-border)",
                backgroundColor: showOriginal ? "color-mix(in srgb, var(--geist-primary) 8%, transparent)" : "transparent",
              }}
            >
              {t("messageDetail.original")}
            </button>
            <button
              onClick={() => setShowOriginal(false)}
              className={cn(
                "h-7 px-3 rounded-geist text-label-12 border transition-colors",
                !showOriginal ? "text-[var(--geist-primary)] font-medium" : "text-secondary",
              )}
              style={{
                borderColor: !showOriginal ? "var(--geist-primary)" : "var(--geist-border)",
                backgroundColor: !showOriginal ? "color-mix(in srgb, var(--geist-primary) 8%, transparent)" : "transparent",
              }}
            >
              {t("messageDetail.translation")}
            </button>
          </div>
        )}
        {/* PGP encrypted email: blurred body + overlay decrypt prompt */}
        <div className="relative">
          {isEncrypted && !pgpDecrypted && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center"
              style={{
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                backgroundColor: "rgba(255,255,255,0.6)",
                borderRadius: 8,
              }}
            >
              <div
                className="rounded-geist border shadow-lg p-6 max-w-md w-full mx-4 space-y-4"
                style={{ borderColor: "var(--geist-border)", backgroundColor: "var(--geist-bg-100)" }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="h-10 w-10 rounded-full flex items-center justify-center shrink-0"
                    style={{ backgroundColor: "color-mix(in srgb, var(--geist-primary) 12%, transparent)" }}
                  >
                    <ShieldAlert size={20} style={{ color: "var(--geist-primary)" }} />
                  </div>
                  <div>
                    <p className="text-label-14 font-semibold">{t("messageDetail.encrypted")}</p>
                    <p className="text-copy-13 text-secondary">
                      {pgpDecrypting ? t("messageDetail.autoDecrypting") : t("messageDetail.noMatchingKey")}
                    </p>
                  </div>
                </div>

                {pgpDecrypting && (
                  <div className="flex items-center justify-center gap-2 py-4 text-label-13 text-secondary">
                    <Loader2 size={16} className="spinner" />
                    {t("messageDetail.decrypting")}
                  </div>
                )}

                {pgpFailed && !pgpDecrypting && (
                  <div className="space-y-3">
                    <p className="text-copy-13 text-secondary">
                      {t("messageDetail.selectKeyInstruction")}
                    </p>
                    <div className="flex gap-2">
                      <label
                        className="h-8 px-3 inline-flex items-center gap-1.5 rounded-geist border cursor-pointer text-label-13 text-secondary hover:bg-[var(--geist-bg-200)]"
                        style={{ borderColor: "var(--geist-border)" }}
                      >
                        <FileIcon filename="" size={13} />
                        {t("messageDetail.selectKeyFile")}
                        <input
                          type="file"
                          accept=".asc,.pgp,.gpg,.key,.txt"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const text = await file.text();
                            setManualKey(text);
                            // Auto-decrypt with file content
                            setPgpDecrypting(true);
                            const ciphertext = message?.body_text || message?.body_html || "";
                            const plain = await tryDecrypt(ciphertext, text);
                            if (plain) {
                              setPgpDecrypted(plain);
                              setPgpFailed(false);
                            } else {
                              showToast(t("messageDetail.decryptionFailed"), "error");
                            }
                            setPgpDecrypting(false);
                            e.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </div>
                    <div className="relative">
                      <div className="absolute left-3 top-2.5 text-label-12 text-secondary">{t("messageDetail.or")}</div>
                      <textarea
                        className="w-full rounded-geist border px-3 pt-7 pb-2 text-label-13 font-mono"
                        style={{ borderColor: "var(--geist-border)", minHeight: 80 }}
                        placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                        value={manualKey}
                        onChange={(e) => setManualKey(e.target.value)}
                      />
                    </div>
                    <Button
                      size="small"
                      loading={pgpDecrypting}
                      onClick={handleManualDecrypt}
                      disabled={!manualKey.trim()}
                    >
                      {t("messageDetail.decrypt")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actual body content — always rendered, blurred when encrypted */}
          {pgpDecrypted ? (
            <div>
              <div className="flex items-center gap-2 mb-3 text-label-12" style={{ color: "var(--geist-green-500)" }}>
                <ShieldAlert size={14} /> {t("messageDetail.decrypted")}
              </div>
              <pre
                className="text-copy-14 whitespace-pre-wrap font-sans m-0"
                style={{ lineHeight: 1.65 }}
              >
                {pgpDecrypted}
              </pre>
            </div>
          ) : (
            <>
            {/* Translated body */}
            {translatedText && !showOriginal ? (
              message.body_html ? (
                <div
                  className="prose prose-sm max-w-none text-copy-14"
                  style={{ lineHeight: 1.65 }}
                  dangerouslySetInnerHTML={{ __html: safeTranslatedHtml }}
                  onContextMenu={handleBodyContextMenu}
                />
              ) : (
                <pre
                  className="text-copy-14 whitespace-pre-wrap font-sans m-0"
                  style={{ lineHeight: 1.65 }}
                  onContextMenu={handleBodyContextMenu}
                >
                  {translatedText}
                </pre>
              )
            ) : message.body_html ? (
              <div
                className="prose prose-sm max-w-none text-copy-14"
                style={{ lineHeight: 1.65 }}
                dangerouslySetInnerHTML={{ __html: safeHtml }}
                onContextMenu={handleBodyContextMenu}
              />
            ) : message.body_text ? (
              <pre
                className="text-copy-14 whitespace-pre-wrap font-sans m-0"
                style={{ lineHeight: 1.65 }}
                onContextMenu={handleBodyContextMenu}
              >
                {decodeQPResidue(message.body_text)}
              </pre>
            ) : (
              <p className="text-copy-13 text-disabled italic">{t("messageDetail.noContent")}</p>
            )}
            </>
          )}
        </div>

        {visibleAttachments.length > 0 && (
          <div className="mt-6 pt-4 border-t" style={{ borderColor: "var(--geist-border)" }}>
            <h3 className="text-label-13 font-semibold mb-2 flex items-center gap-2">
              <Paperclip size={13} /> {t("settings.attachments.title")}
            </h3>
            <div className="flex flex-col gap-2">
              {visibleAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 rounded-geist border px-3 py-2 text-label-13"
                  style={{ borderColor: "var(--geist-border)" }}
                >
                  <FileIcon filename={att.filename} mimeType={att.mime_type} size={13} className="shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{att.filename}</span>
                  <span className="text-label-12 text-secondary">
                    {att.size > 0 ? formatBytes(att.size) : ""}
                  </span>
                  {isPreviewable(att.mime_type) && (
                    <button
                      onClick={() => setPreviewAtt(att)}
                      className="h-6 px-2 rounded-geist text-label-12 border shrink-0 hover:bg-[var(--geist-bg-200)]"
                      style={{ borderColor: "var(--geist-border)", color: "var(--geist-primary)" }}
                    >
                      {t("messageDetail.preview")}
                    </button>
                  )}
                  <a
                    href={attachmentsApi.url(att.id)}
                    download={att.filename}
                    className="h-6 px-2 inline-flex items-center rounded-geist text-label-12 border shrink-0 hover:bg-[var(--geist-bg-200)]"
                    style={{ borderColor: "var(--geist-border)", color: "var(--geist-secondary)" }}
                  >
                    {t("messageDetail.download")}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
        </>
        )}
        </div>
      </div>
      {bodyMenu && createPortal(
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          className="min-w-[160px] py-1 rounded-geist border bg-geist-bg-100 shadow-popover animate-fade-in-fast"
          style={{
            position: "fixed",
            left: Math.min(bodyMenu.x, window.innerWidth - 200),
            top: Math.min(bodyMenu.y, window.innerHeight - 120),
            zIndex: 9999,
          }}
        >
          <button
            onClick={() => { translateSelection(); setBodyMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-label-13 hover:bg-[var(--mailgo-sidebar-hover)]"
            style={{ color: "var(--geist-primary)" }}
          >
            <Languages size={14} /> {t("messageDetail.translateSelected")}
          </button>
          <button
            onClick={() => { askAIAboutSelection(); setBodyMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-label-13 hover:bg-[var(--mailgo-sidebar-hover)]"
            style={{ color: "var(--geist-primary)" }}
          >
            <Bot size={14} /> {t("messageDetail.aiAssistant")}
          </button>
        </div>,
        document.body,
      )}
      {previewAtt && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center p-6 animate-fade-in-fast"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
          onClick={() => setPreviewAtt(null)}
        >
          <div
            className="relative w-full max-w-[900px] h-[85vh] rounded-geist-md overflow-hidden flex flex-col"
            style={{ backgroundColor: "var(--geist-bg-100)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-4 h-12 border-b shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <FileIcon filename={previewAtt.filename} mimeType={previewAtt.mime_type} size={15} />
              <span className="text-label-14 font-semibold truncate flex-1">
                {previewAtt.filename}
              </span>
              <a
                href={attachmentsApi.url(previewAtt.id)}
                download={previewAtt.filename}
                className="h-7 px-3 inline-flex items-center gap-1.5 rounded-geist text-label-12 border"
                style={{ borderColor: "var(--geist-border)", color: "var(--geist-secondary)" }}
              >
                {t("messageDetail.download")}
              </a>
              <button
                onClick={() => setPreviewAtt(null)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)]"
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: "#f5f5f5" }}>
              {renderAttachmentPreview(previewAtt, t)}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {(rawSource !== null || rawLoading || rawError) && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center p-6 animate-fade-in-fast"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
          onClick={() => { setRawSource(null); setRawError(null); }}
        >
          <div
            className="relative w-full max-w-[1000px] h-[85vh] rounded-geist-md overflow-hidden flex flex-col"
            style={{ backgroundColor: "var(--geist-bg-100)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-4 h-12 border-b shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <Code size={15} className="text-secondary" />
              <span className="text-label-14 font-semibold truncate flex-1">
                {t("messageDetail.sourceTitle")}
              </span>
              {rawSource && (
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(rawSource);
                      setCopiedRaw(true);
                      setTimeout(() => setCopiedRaw(false), 1500);
                    } catch {
                      showToast(t("messageDetail.copyFailed"), "error");
                    }
                  }}
                  className="h-7 px-3 inline-flex items-center gap-1.5 rounded-geist text-label-12 border"
                  style={{ borderColor: "var(--geist-border)", color: "var(--geist-secondary)" }}
                >
                  <Copy size={12} />
                  {copiedRaw ? t("common.copied") : t("common.copy")}
                </button>
              )}
              <button
                onClick={() => { setRawSource(null); setRawError(null); }}
                className="h-8 w-8 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)]"
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: "#f5f5f5" }}>
              {rawLoading ? (
                <div className="flex items-center justify-center h-full gap-2 text-label-13 text-secondary">
                  <Loader2 size={14} className="spinner" /> {t("messageDetail.fetchingSource")}
                </div>
              ) : rawError ? (
                <div className="flex items-center justify-center h-full text-label-13 text-center px-8" style={{ color: "var(--geist-red-500)" }}>
                  {rawError}
                </div>
              ) : (
                <pre
                  className="m-0 p-4 text-copy-12 whitespace-pre-wrap break-words font-mono"
                  style={{ color: "var(--geist-primary)", lineHeight: 1.5 }}
                >
                  {rawSource}
                </pre>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ThreadMessageCard({
  message,
  expanded,
  onToggle,
  onContextMenu,
  onPreviewAttachment,
}: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPreviewAttachment: (att: Attachment) => void;
}) {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const autoLoadRemoteResources =
    settings.find((s) => s.key === "auto_load_remote_resources")?.value === "true";
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState(false);
  const { data: attachments = [] } = useQuery({
    queryKey: ["attachments", message.id],
    queryFn: () => attachmentsApi.list(message.id),
    enabled: expanded,
  });

  useEffect(() => {
    setRemoteImagesAllowed(false);
  }, [message.id]);

  useEffect(() => {
    setRemoteImagesAllowed(autoLoadRemoteResources);
  }, [message.id, autoLoadRemoteResources]);

  const toList = safeJSON<Array<{ name?: string; address: string }>>(
    message.to_addresses,
    [],
  );
  const ccList = safeJSON<Array<{ name?: string; address: string }>>(
    message.cc_addresses,
    [],
  );
  const fromName = message.from_name?.trim() || message.from_address;
  const htmlWithInlineAttachments = useMemo(
    () => resolveInlineImages(message.body_html, attachments),
    [message.body_html, attachments],
  );
  const { html: safeHtml, hasRemoteImages } = useMemo(
    () => processRemoteImages(htmlWithInlineAttachments, remoteImagesAllowed),
    [htmlWithInlineAttachments, remoteImagesAllowed],
  );
  const hasRemoteLinks =
    !message.body_html && !!message.body_text && /https?:\/\//i.test(message.body_text);
  const showRemoteBanner = hasRemoteImages || hasRemoteLinks;
  const visibleAttachments = attachments.filter((a) => !a.content_id);

  return (
    <section
      className="rounded-geist border overflow-hidden"
      style={{ borderColor: "var(--geist-border)", backgroundColor: "#ffffff" }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-start gap-3 text-left"
        style={{ backgroundColor: expanded ? "#ffffff" : "#f8fafc", color: "#111827" }}
      >
        <Avatar name={message.from_name} email={message.from_address} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-label-14 font-semibold truncate">{fromName}</span>
            {!message.is_read && (
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: "var(--geist-tertiary)" }} />
            )}
            {message.has_attachments && <Paperclip size={13} className="text-secondary shrink-0" />}
          </div>
          <div className="text-label-12 text-secondary truncate">
            {toList.length > 0
              ? `to ${toList.map((a) => {
                  const name = a.name?.trim();
                  return name && name !== a.address ? `${name} (${a.address})` : (name || a.address);
                }).join(", ")}`
              : message.from_address}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-label-12 text-secondary">
          <span>{formatDateTime(message.received_at)}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          {ccList.length > 0 && (
            <p className="text-label-12 text-secondary mb-3">
              <span className="text-disabled">cc </span>
              {ccList.map((a) => {
                const name = a.name?.trim();
                return name && name !== a.address ? `${name} (${a.address})` : (name || a.address);
              }).join(", ")}
            </p>
          )}
          {showRemoteBanner && !remoteImagesAllowed && (
            <div
              className="flex items-center justify-between gap-3 rounded-geist border px-3 py-2 mb-4"
              style={{
                borderColor: "var(--geist-amber-200, #fcd34d)",
                backgroundColor: "var(--geist-amber-100, #fef3c7)",
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <ImageOff size={14} className="shrink-0" style={{ color: "#b45309" }} />
                <span className="text-label-13" style={{ color: "#92400e" }}>
                  {t("message.remoteImagesBlocked")}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setRemoteImagesAllowed(true)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-geist text-label-12 font-medium shrink-0"
                style={{ backgroundColor: "white", color: "#92400e", border: "1px solid #fcd34d" }}
              >
                <ImageIcon size={12} />
                {t("message.loadImages")}
              </button>
            </div>
          )}

          {message.body_html ? (
            <div
              className="prose prose-sm max-w-none text-copy-14"
              style={{ color: "#111827", lineHeight: 1.65 }}
              dangerouslySetInnerHTML={{ __html: safeHtml }}
              onContextMenu={onContextMenu}
            />
          ) : message.body_text ? (
            <pre
              className="text-copy-14 whitespace-pre-wrap font-sans m-0"
              style={{ lineHeight: 1.65, color: "#111827" }}
              onContextMenu={onContextMenu}
            >
              {decodeQPResidue(message.body_text)}
            </pre>
          ) : (
            <p className="text-copy-13 text-disabled italic">{t("messageDetail.noContent")}</p>
          )}

          {visibleAttachments.length > 0 && (
            <div className="mt-6 pt-4 border-t" style={{ borderColor: "var(--geist-border)" }}>
              <h3 className="text-label-13 font-semibold mb-2 flex items-center gap-2">
                <Paperclip size={13} /> {t("settings.attachments.title")}
              </h3>
              <div className="flex flex-col gap-2">
                {visibleAttachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-2 rounded-geist border px-3 py-2 text-label-13"
                    style={{ borderColor: "var(--geist-border)" }}
                  >
                    <FileIcon filename={att.filename} mimeType={att.mime_type} size={13} className="shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{att.filename}</span>
                    {att.content_id && <span className="text-label-11 text-secondary">inline</span>}
                    <span className="text-label-12 text-secondary">
                      {att.size > 0 ? formatBytes(att.size) : ""}
                    </span>
                    {isPreviewable(att.mime_type) && (
                      <button
                        onClick={() => onPreviewAttachment(att)}
                        className="h-6 px-2 rounded-geist text-label-12 border shrink-0 hover:bg-[var(--geist-bg-200)]"
                        style={{ borderColor: "var(--geist-border)", color: "var(--geist-primary)" }}
                      >
                        {t("messageDetail.preview")}
                      </button>
                    )}
                    <a
                      href={attachmentsApi.url(att.id)}
                      download={att.filename}
                      className="h-6 px-2 inline-flex items-center rounded-geist text-label-12 border shrink-0 hover:bg-[var(--geist-bg-200)]"
                      style={{ borderColor: "var(--geist-border)", color: "var(--geist-secondary)" }}
                    >
                      {t("messageDetail.download")}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** isPreviewable checks whether the browser can render this MIME type. */
function isPreviewable(mimeType: string): boolean {
  const mt = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (
    mt === "application/pdf" || mt === "application/x-pdf" ||
    mt.startsWith("image/") ||
    mt === "text/plain" || mt === "text/csv" || mt === "text/html" ||
    mt === "text/markdown" || mt === "text/xml" ||
    mt === "application/json" || mt === "application/xml" ||
    mt === "video/mp4" || mt === "video/webm" ||
    mt === "audio/mpeg" || mt === "audio/ogg" || mt === "audio/wav"
  ) {
    return true;
  }
  // Fallback: check by file extension for common types
  return false;
}

/** renderAttachmentPreview renders the appropriate inline previewer. */
function renderAttachmentPreview(att: Attachment, t: (key: string) => string): React.ReactNode {
  const url = attachmentsApi.url(att.id);
  const mt = (att.mime_type || "").split(";")[0].trim().toLowerCase();

  // PDF — render with PDF.js for reliable cross-browser preview
  if (mt === "application/pdf" || mt === "application/x-pdf") {
    return <PdfPreview attachment={att} />;
  }

  // Images — show inline with loading indicator
  if (mt.startsWith("image/")) {
    return (
      <div className="flex items-center justify-center min-h-full p-4">
        <img
          src={url}
          alt={att.filename}
          className="max-w-full max-h-full object-contain"
          referrerPolicy="no-referrer"
          onLoadStart={(e) => {
            // Show a spinner while the image loads from IMAP.
            const parent = e.currentTarget.parentElement!;
            if (!parent.querySelector(".att-loading")) {
              const spinner = document.createElement("div");
              spinner.className = "att-loading";
              spinner.innerHTML = '<svg class="spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
              spinner.style.cssText = "position:absolute;display:flex;align-items:center;justify-content:center";
              parent.style.position = "relative";
              parent.appendChild(spinner);
            }
          }}
          onLoad={(e) => {
            e.currentTarget.parentElement?.querySelector(".att-loading")?.remove();
          }}
          onError={(e) => {
            e.currentTarget.parentElement?.querySelector(".att-loading")?.remove();
          }}
        />
      </div>
    );
  }

  // Video
  if (mt.startsWith("video/")) {
    return (
      <div className="flex items-center justify-center min-h-full p-4">
        <video src={url} controls className="max-w-full max-h-full" />
      </div>
    );
  }

  // Audio
  if (mt.startsWith("audio/")) {
    return (
      <div className="flex items-center justify-center min-h-full p-8">
        <audio src={url} controls />
      </div>
    );
  }

  // Text-based — fetch and display in a <pre>
  if (
    mt === "text/plain" || mt === "text/csv" || mt === "text/html" ||
    mt === "text/markdown" || mt === "text/xml" ||
    mt === "application/json" || mt === "application/xml" ||
    mt === "application/javascript" || mt === "text/javascript" || mt === "text/css"
  ) {
    return <TextPreview url={url} />;
  }

  // Fallback — can't preview
  return (
    <div className="flex items-center justify-center h-full text-label-14 text-secondary">
      {t("messageDetail.fileCannotPreview")}
    </div>
  );
}

/** TextPreview fetches a text attachment and renders it in a scrollable <pre>. */
function TextPreview({ url }: { url: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch(url)
      .then((res) => res.text())
      .then((t) => { if (!cancelled) setText(t); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [url]);
  if (error) return <div className="p-4 text-label-13 text-secondary">{t("messageDetail.loadFailed")}</div>;
  if (text === null) return <div className="p-4 text-label-13 text-secondary">{t("messageDetail.loading")}</div>;
  return (
    <pre
      className="p-4 m-0 text-copy-13 whitespace-pre-wrap break-words font-mono"
      style={{ color: "var(--geist-primary)" }}
    >
      {text}
    </pre>
  );
}

function normalizeContentID(value: string) {
  return value.trim().replace(/^<|>$/g, "");
}

/**
 * decodeQPResidue cleans up quoted-printable encoding artifacts that remain
 * in plain-text bodies when older messages were synced before full QP
 * decoding was in place. It handles:
 *   - soft line breaks: "=\n" / "=\r\n" / "= " (corrupted soft break)
 *   - hex escapes: "=E4=BA=B2" → the UTF-8 bytes for "亲"
 * This is a best-effort client-side fixup so the user sees readable text
 * without needing to re-sync. New messages are decoded server-side.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeQPResidue(text: string): string {
  if (!text) return text;
  // First, remove soft line breaks. A proper QP soft break is "=\r\n" or
  // "=\n". Some corrupted bodies have "= " (equals + space) where the
  // newline was normalized away — strip those too.
  let out = text.replace(/=\r?\n/g, "").replace(/= (?=\S)/g, "");
  // Then decode "=XX" hex sequences into actual bytes, interpreting the
  // result as UTF-8.
  if (out.includes("=")) {
    const bytes: number[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "=" && i + 2 < out.length) {
        const hex = out.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      bytes.push(out.charCodeAt(i) & 0xff);
    }
    try {
      out = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    } catch {
      /* keep original if decode fails */
    }
  }
  return out;
}

function resolveInlineImages(html: string, attachments: Attachment[]) {
  if (!html || attachments.length === 0) return html;
  const byCID = new Map(
    attachments
      .filter((a) => a.content_id)
      .map((a) => [normalizeContentID(a.content_id), attachmentsApi.url(a.id)]),
  );
  return html.replace(/src=(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const url = byCID.get(normalizeContentID(cid));
    return url ? `src=${quote}${url}${quote}` : match;
  });
}

/**
 * stripTrackingPixels removes tracking pixels and beacons from email HTML.
 * Detection rules (inspired by eM Client + EasyPrivacy patterns):
 *  1. Known tracking domains/patterns in image URLs
 *  2. Images with 1x1 / 0x0 dimensions (explicit or style)
 *  3. Hidden images (display:none, visibility:hidden, opacity:0, font-size:0)
 *  4. URLs containing tracking keywords (track, pixel, beacon, open, analytics)
 *  5. Images wrapped in links to known ESP tracking endpoints
 */
function stripTrackingPixels(html: string): { html: string; count: number } {
  if (!html) return { html: "", count: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  let count = 0;

  // Known tracking URL patterns (domains + path keywords)
  const TRACKING_PATTERNS = [
    // ESP tracking domains
    /track\.hubspot\.com/i,
    /t\.signaux/i,
    /t\.sidekickopen/i,
    /list-manage\d*\.com/i,
    /sendgrid\.net/i,
    /sendfox\.com/i,
    /mailtrack\.io/i,
    /trackcmp\.net/i,
    /createsend\d*\.com/i,
    /sibautomation\.com/i,
    /trk\.klaviyomail\.com/i,
    /mandrillapp\.com/i,
    /mailchimpapp\.net/i,
    /intercom-mail\.com/i,
    /intercom\.io/i,
    /customeriomail\.com/i,
    /app\.loops\.so/i,
    /resend\.com/i,
    /postmarkapp\.com/i,
    /email\.mg\./i,
    /open\.replay\.com/i,
    /pixel\.app\./i,
    /analytics\./i,
    /beacon\./i,
    /tracking\./i,
    /pixel\./i,
    // URL path keywords (common in tracking pixels)
    /\/open\.gif/i,
    /\/open\.png/i,
    /\/pixel\.gif/i,
    /\/pixel\.png/i,
    /\/track\//i,
    /\/beacon\//i,
    /\/t\//i,
    /\/wf\/open/i,
    /\/o\/[^/]*\?/i,
    /\/ss\/[^/]*\?/i,
    /\/ci\/\?/i,
    /\/trk\//i,
  ];

  const isRemote = (url: string) => /^https?:\/\//i.test(url.trim());

  const isTrackingUrl = (url: string): boolean => {
    if (!isRemote(url)) return false;
    return TRACKING_PATTERNS.some((p) => p.test(url));
  };

  const isHidden = (el: Element): boolean => {
    const w = el.getAttribute("width");
    const h = el.getAttribute("height");
    // Explicit 1x1 or 0x0
    if ((w === "1" || w === "0") && (h === "1" || h === "0")) return true;
    const style = (el.getAttribute("style") || "").toLowerCase();
    if (/display\s*:\s*none/i.test(style)) return true;
    if (/visibility\s*:\s*hidden/i.test(style)) return true;
    if (/opacity\s*:\s*0(\.0*)?/i.test(style)) return true;
    if (/font-size\s*:\s*0/i.test(style)) return true;
    if (/line-height\s*:\s*0/i.test(style)) return true;
    if (/max-height\s*:\s*0/i.test(style)) return true;
    if (/max-width\s*:\s*0/i.test(style)) return true;
    if (/height\s*:\s*0/i.test(style) && !/height\s*:\s*0[^.]*/i.test(style)) return true;
    // Hidden attribute
    if (el.hasAttribute("hidden")) return true;
    // CSS class hints
    const cls = el.getAttribute("class") || "";
    if (/display-none|invisible|hidden|sr-only|visually-hidden/i.test(cls)) return true;
    return false;
  };

  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    if (!isRemote(src)) return;
    if (isTrackingUrl(src) || isHidden(img)) {
      img.remove();
      count++;
    }
  });

  // Also check <img> inside <a> tags pointing to tracking URLs
  doc.querySelectorAll("a img").forEach((img) => {
    const anchor = img.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    const src = img.getAttribute("src") || "";
    if (isRemote(src) && (isTrackingUrl(href) || isTrackingUrl(src))) {
      // Remove the entire anchor if it only contains the tracking image
      if (anchor.children.length === 1) {
        anchor.remove();
      } else {
        img.remove();
      }
      count++;
    }
  });

  // Remove tracking scripts (beacon via navigator.sendBeacon or fetch)
  doc.querySelectorAll("script").forEach((s) => {
    const text = s.textContent || "";
    if (/sendBeacon|navigator\.send|pixel|track|beacon/i.test(text)) {
      s.remove();
      count++;
    }
  });

  // Remove <img> with srcset containing tracking patterns
  doc.querySelectorAll("img[srcset]").forEach((img) => {
    const srcset = img.getAttribute("srcset") || "";
    if (isRemote(srcset) && isTrackingUrl(srcset)) {
      img.remove();
      count++;
    }
  });

  return { html: doc.body.innerHTML, count };
}

/**
 * sanitizeMailHtml neutralizes every mechanism by which an email's HTML
 * can trigger a request to a remote server when rendered via
 * dangerouslySetInnerHTML. Without this, marketing emails (Oracle,
 * newsletters, tracking pixels, …) would leak the user's IP / read
 * status to the sender, and malformed attribute values like
 * `="https://example.com/...` would produce bogus requests such as
 * `http://localhost:8080/3D%22https://...`.
 *
 * When `allow` is false (default), remote URLs are stripped / replaced
 * with placeholders. When `allow` is true, blocked resources are
 * restored. Inline resources (cid:, data:, same-origin /api/) are
 * always preserved.
 *
 * Returns the rewritten HTML and whether the message contained any
 * remote resources (used to show the "click to load" banner).
 */
function processRemoteImages(
  html: string,
  allow: boolean,
): { html: string; hasRemoteImages: boolean } {
  if (!html) return { html: "", hasRemoteImages: false };
  const doc = new DOMParser().parseFromString(html, "text/html");
  let hasRemoteImages = false;
  const PLACEHOLDER =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  const isRemote = (url: string) => /^https?:\/\//i.test(url.trim());

  // --- <img src> ---
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!isRemote(src)) return;
    hasRemoteImages = true;
    if (allow) {
      const dataSrc = img.getAttribute("data-src");
      if (dataSrc) {
        img.setAttribute("src", dataSrc);
        img.removeAttribute("data-src");
      }
    } else {
      if (!img.getAttribute("data-src")) img.setAttribute("data-src", src);
      img.setAttribute("src", PLACEHOLDER);
    }
  });

  // --- <link rel=stylesheet href>, <script src>, <iframe src>,
  // <embed>, <object>, <video>/<audio> src/poster ---
  // These are stripped entirely (or neutralized) because they auto-load.
  const STRIP_TAGS = ["script", "style", "iframe", "embed", "object", "link", "meta", "base"];
  STRIP_TAGS.forEach((tag) => {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  });

  // --- srcset on <img>/<source> (responsive images) ---
  doc.querySelectorAll("[srcset]").forEach((el) => {
    const srcset = el.getAttribute("srcset") || "";
    if (isRemote(srcset)) {
      hasRemoteImages = true;
      if (!allow) el.removeAttribute("srcset");
    }
  });

  // --- background attribute (legacy HTML, e.g. <td background="...">) ---
  doc.querySelectorAll("[background]").forEach((el) => {
    const bg = el.getAttribute("background") || "";
    if (!isRemote(bg)) return;
    hasRemoteImages = true;
    if (allow) {
      const saved = el.getAttribute("data-background");
      if (saved) {
        el.setAttribute("background", saved);
        el.removeAttribute("data-background");
      }
    } else {
      if (!el.getAttribute("data-background"))
        el.setAttribute("data-background", bg);
      el.removeAttribute("background");
    }
  });

  // --- Inline style="...url(...)..." ---
  doc.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    if (!/url\(/i.test(style)) return;
    // Any url(http...) in inline CSS is treated as a remote resource.
    if (!isRemote(style)) return;
    hasRemoteImages = true;
    if (allow) {
      const saved = el.getAttribute("data-style");
      if (saved) {
        el.setAttribute("style", saved);
        el.removeAttribute("data-style");
      }
    } else {
      if (!el.getAttribute("data-style")) el.setAttribute("data-style", style);
      // Strip all url() references from the inline style.
      el.setAttribute(
        "style",
        style.replace(/url\([^)]*\)/gi, "none"),
      );
    }
  });

  return { html: doc.body.innerHTML, hasRemoteImages };
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function messageTime(message: { received_at?: string; sent_at?: string }): number {
  const value = Date.parse(message.received_at || message.sent_at || "");
  return Number.isFinite(value) ? value : 0;
}

/**
 * extractHtmlTexts walks the DOM tree of `html` and collects all visible
 * text nodes. Returns:
 *  - `html`: the original HTML (untouched — for later re-processing)
 *  - `texts`: array of text strings in document order
 *  - `replacements`: ordered array of { path, start, end } indicating
 *     the character range in `html` that each text occupies.
 *
 * The caller sends `texts` to the AI for translation, then calls
 * `applyTranslations(html, replacements, translatedLines)` to splice the
 * translated text back in.
 */
function extractHtmlTexts(html: string): {
  html: string;
  texts: string[];
  replacements: Array<{ start: number; end: number }>;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "HEAD", "META", "LINK"]);
  const texts: string[] = [];
  const textNodes: Text[] = [];

  function walk(node: Node) {
    if (SKIP.has(node.nodeName)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || "").trim();
      if (t) {
        texts.push(t);
        textNodes.push(node as Text);
      }
    } else {
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  }
  walk(doc.body);

  // Serialize the DOM and find each text node's position in the serialized HTML.
  // We use a marker approach: temporarily replace each text with a unique token,
  // serialize, note the position, then restore.
  const markers: string[] = [];
  const originalTexts: string[] = [];
  for (let i = 0; i < textNodes.length; i++) {
    const marker = `__TXT${i}END__`;
    markers.push(marker);
    originalTexts.push(textNodes[i].textContent || "");
    textNodes[i].textContent = marker;
  }

  const serialized = doc.body.innerHTML;
  const replacements: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < markers.length; i++) {
    const idx = serialized.indexOf(markers[i]);
    if (idx >= 0) {
      replacements.push({ start: idx, end: idx + markers[i].length });
    } else {
      replacements.push({ start: -1, end: -1 });
    }
    // Restore original text.
    textNodes[i].textContent = originalTexts[i];
  }

  return { html: doc.body.innerHTML, texts, replacements };
}

/**
 * applyTranslations splices translated text back into the original HTML
 * at the positions recorded by extractHtmlTexts.
 */
function applyTranslations(
  html: string,
  replacements: Array<{ start: number; end: number }>,
  translatedLines: string[],
): string {
  // Process replacements in reverse order so earlier offsets remain valid.
  const pairs: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < replacements.length && i < translatedLines.length; i++) {
    if (replacements[i].start < 0) continue;
    const text = translatedLines[i];
    if (!text) continue;
    pairs.push({ ...replacements[i], text });
  }
  // Sort by start descending.
  pairs.sort((a, b) => b.start - a.start);

  let result = html;
  for (const { start, end, text } of pairs) {
    result = result.slice(0, start) + escapeHtml(text) + result.slice(end);
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
