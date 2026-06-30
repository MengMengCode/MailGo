import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Send,
  Trash2,
  X,
  CircleDashed,
  Check,
  AlertCircle,
  Paperclip,
  Image as ImageIcon,
  File as FileIcon,
  Save,
  Lock,
  Unlock,
  Sparkles,
} from "lucide-react";
import {
  RichTextEditor,
  type InlineImageInfo,
  type RichTextEditorHandle,
} from "@/components/RichTextEditor";
import { ComposeAIPanel, type ComposeAIContext } from "@/components/ai/ComposeAIPanel";
import { useAppStore } from "@/stores/appStore";
import { useMessageQuery } from "@/hooks/queries/useMessages";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import { useDraftQuery } from "@/hooks/queries/useDrafts";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import {
  useSendMessage,
} from "@/hooks/mutations/useMessageMutations";
import {
  useSaveDraft,
  useUpdateDraft,
  useDeleteDraft,
  usePermanentDeleteDraft,
} from "@/hooks/mutations/useDraftMutations";
import { showToast } from "@/stores/toast.store";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm } from "@/stores/confirm.store";
import { safeJSON, parseAddressList, formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { AttachmentInput } from "@/lib/api";
import { pgpKeysApi, type PGPKey } from "@/lib/api";
import { encryptMessage } from "@/lib/pgp";
import { useQuery } from "@tanstack/react-query";
import { useIsMobile } from "@/hooks/useBreakpoint";

/** Max attachment size per file — 25 MB to stay within typical SMTP limits. */
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

interface LocalAttachment {
  id: string; // unique within this compose session
  filename: string;
  mime_type: string;
  size: number;
  content_id?: string; // set when the attachment is an inline image
  data_base64: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Default auto-save cadence (ms) when the setting is not configured. */
const DEFAULT_AUTOSAVE_MS = 10_000;

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

export function ComposeView() {
  const { t } = useTranslation();
  const composeMode = useAppStore((s) => s.composeMode);
  const composeReplyId = useAppStore((s) => s.composeReplyId);
  const composeDraftId = useAppStore((s) => s.composeDraftId);
  const composeKey = useAppStore((s) => s.composeKey);
  const closeCompose = useAppStore((s) => s.closeCompose);
  const activeAccountId = useAppStore((s) => s.activeAccountId);
  const isMobile = useIsMobile();

  const { data: accounts = [] } = useAccountsQuery();
  const { data: replyMsg } = useMessageQuery(
    composeMode !== "new" ? composeReplyId : null,
  );
  const { data: existingDraft } = useDraftQuery(
    composeMode === "new" ? composeDraftId : null,
  );
  const { data: settings = [] } = useSettingsQuery();

  // Auto-save interval: read from the "autosave_interval" setting
  // (in seconds). Falls back to 10s. Setting it to 0 disables autosave.
  const autosaveMs = useMemo(() => {
    const raw = settings.find((s) => s.key === "autosave_interval")?.value;
    const seconds = raw ? Number(raw) : 10;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.max(5, seconds) * 1000;
  }, [settings]);
  const sendMessage = useSendMessage();
  const saveDraft = useSaveDraft();
  const updateDraft = useUpdateDraft();
  const deleteDraft = useDeleteDraft();
  const permanentDeleteDraft = usePermanentDeleteDraft();

  const [fromAccountId, setFromAccountId] = useState<number | null>(
    activeAccountId ?? accounts[0]?.id ?? null,
  );
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [encryptKeyId, setEncryptKeyId] = useState<number | null>(null);
  const [showEncryptPicker, setShowEncryptPicker] = useState(false);
  const { data: pgpKeys = [] } = useQuery({
    queryKey: ["pgp-keys"],
    queryFn: () => pgpKeysApi.list(),
    staleTime: 60_000,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorHandleRef = useRef<RichTextEditorHandle>(null);

  // --- AI panel state ---
  const [aiOpen, setAiOpen] = useState(false);
  const [aiContexts, setAiContexts] = useState<ComposeAIContext[]>([]);
  const [editorSelection, setEditorSelection] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  /** The local id of the draft that we are auto-saving to. Starts as the
   *  value pulled from the store (a draft the user resumed) and gets set
   *  the first time we POST a new draft. */
  const [draftId, setDraftId] = useState<number | null>(composeDraftId);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const [nextAutosaveAt, setNextAutosaveAt] = useState<number | null>(null);
  const [statusNow, setStatusNow] = useState(Date.now());
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // Track whether the form has unsaved edits since the last save.
  const dirtyRef = useRef(false);
  const skipDirtyRef = useRef(true);
  // Last sent content snapshot used to decide if anything actually changed
  // before triggering a network round-trip.
  const lastSentRef = useRef<string>("");

  // Reset fields on a new compose session (or when the user resumes a draft).
  useEffect(() => {
    setFromAccountId(activeAccountId ?? accounts[0]?.id ?? null);
    dirtyRef.current = false;
    skipDirtyRef.current = true;
    lastSentRef.current = "";
    setNextAutosaveAt(null);
    setSaveStatus({ kind: "idle" });

    if (composeMode === "new" && existingDraft) {
      // Resuming a saved draft.
      setTo(addressListToString(existingDraft.to_addresses));
      setCc(addressListToString(existingDraft.cc_addresses));
      setBcc(addressListToString(existingDraft.bcc_addresses));
      setSubject(existingDraft.subject || "");
      setBody(existingDraft.body_html || existingDraft.body_text || "");
      setDraftId(existingDraft.id);
      setFromAccountId(existingDraft.account_id || null);
      lastSentRef.current = serializeSnapshot(existingDraft);
      setSaveStatus({ kind: "saved", at: Date.parse(existingDraft.updated_at) || Date.now() });
      setShowCc(!!existingDraft.cc_addresses);
      setShowBcc(!!existingDraft.bcc_addresses);
      return;
    }

    // If we're editing a draft but it hasn't loaded yet, don't clear
    // the fields — a separate effect will fill them once it arrives.
    if (composeMode === "new" && composeDraftId && !existingDraft) {
      return;
    }

    if (composeMode === "new" || !replyMsg) {
      setTo("");
      setCc("");
      setBcc("");
      setSubject("");
      setBody("");
      setShowCc(false);
      setShowBcc(false);
      setDraftId(null);
      return;
    }

    const fromAddr = replyMsg.from_address;
    const originalBody = replyMsg.body_html || replyMsg.body_text || replyMsg.snippet || "";
    if (composeMode === "reply" || composeMode === "reply_all") {
      setTo(fromAddr);
      setCc("");
      setSubject(`Re: ${replyMsg.subject || ""}`);
      setBody(
        `<div><br/>On ${formatDateTime(replyMsg.received_at)}, ${
          replyMsg.from_name || fromAddr
        } wrote:<br/><blockquote>${originalBody}</blockquote></div>`,
      );
    } else if (composeMode === "forward") {
      setSubject(`Fwd: ${replyMsg.subject || ""}`);
      const toList = safeJSON<Array<{ address: string }>>(
        replyMsg.to_addresses,
        [],
      );
      setBody(
        `<div><br/>---------- Forwarded message ----------<br/>From: ${replyMsg.from_name} &lt;${replyMsg.from_address}&gt;<br/>Date: ${formatDateTime(
          replyMsg.received_at,
        )}<br/>Subject: ${replyMsg.subject}<br/>To: ${toList
          .map((a) => a.address)
          .join(", ")}<br/><br/>${originalBody}</div>`,
      );
    }
  }, [composeKey]);

  // Fill form when draft data arrives after the initial render (async fetch).
  useEffect(() => {
    if (composeMode === "new" && composeDraftId && existingDraft) {
      setTo(addressListToString(existingDraft.to_addresses));
      setCc(addressListToString(existingDraft.cc_addresses));
      setBcc(addressListToString(existingDraft.bcc_addresses));
      setSubject(existingDraft.subject || "");
      setBody(existingDraft.body_html || existingDraft.body_text || "");
      setDraftId(existingDraft.id);
      setFromAccountId(existingDraft.account_id || null);
      lastSentRef.current = serializeSnapshot(existingDraft);
      setSaveStatus({ kind: "saved", at: Date.parse(existingDraft.updated_at) || Date.now() });
      setShowCc(!!existingDraft.cc_addresses);
      setShowBcc(!!existingDraft.bcc_addresses);
    }
  }, [existingDraft, composeDraftId, composeMode]);

  useEffect(() => {
    if (!fromAccountId && accounts.length > 0) {
      setFromAccountId(accounts[0].id);
    }
  }, [accounts, fromAccountId]);

  // Build the snapshot used to detect changes and to send to the server.
  const snapshot = useMemo(
    () =>
      serializeForm({
        accountId: fromAccountId,
        to,
        cc,
        bcc,
        subject,
        body,
      }),
    [fromAccountId, to, cc, bcc, subject, body],
  );

  const triggerAutoSave = useCallback(async (force = false): Promise<boolean> => {
    if (!force && !dirtyRef.current) return false;
    if (saveStatus.kind === "saving") return false;
    if (!fromAccountId) return false;

    // Nothing to save if everything is empty.
    // body is HTML from the rich-text editor — strip tags to detect truly
    // empty content (e.g. "<p><br></p>").
    const bodyText = body.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
    if (!to.trim() && !subject.trim() && !bodyText) {
      // If we have a draft id, delete it because the user has cleared the form.
      if (draftId) {
        try {
          await permanentDeleteDraft.mutateAsync(draftId);
          setDraftId(null);
          setSaveStatus({ kind: "idle" });
          setNextAutosaveAt(null);
        } catch {
          /* ignore — will retry on next tick */
        }
        dirtyRef.current = false;
        return true;
      }
      return false;
    }

    const payload = {
      account_id: fromAccountId,
      to_addresses: JSON.stringify(parseAddressList(to)),
      cc_addresses: JSON.stringify(parseAddressList(cc)),
      bcc_addresses: JSON.stringify(parseAddressList(bcc)),
      subject,
      body_html: body,
      body_text: body.replace(/<[^>]+>/g, ""),
      in_reply_to: replyMsg?.message_id || "",
      references: replyMsg?.references || "",
    };
    setSaveStatus({ kind: "saving" });
    try {
      if (draftId) {
        await updateDraft.mutateAsync({ id: draftId, data: payload });
      } else {
        const res = await saveDraft.mutateAsync(payload);
        setDraftId(res.id);
      }
      lastSentRef.current = snapshot;
      dirtyRef.current = false;
      setNextAutosaveAt(null);
      setSaveStatus({ kind: "saved", at: Date.now() });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("compose.saveFailed");
      setSaveStatus({ kind: "error", message: msg });
      return false;
    }
  }, [
    saveStatus.kind,
    fromAccountId,
    to,
    cc,
    bcc,
    subject,
    body,
    draftId,
    replyMsg,
    deleteDraft,
    permanentDeleteDraft,
    updateDraft,
    saveDraft,
    snapshot,
  ]);

  // Mark the form dirty whenever any field changes.
  useEffect(() => {
    if (skipDirtyRef.current) {
      lastSentRef.current = snapshot;
      skipDirtyRef.current = false;
      return;
    }
    if (snapshot !== lastSentRef.current) {
      dirtyRef.current = true;
      setSaveStatus((current) =>
        current.kind === "saving" ? current : { kind: "idle" },
      );
      setNextAutosaveAt(autosaveMs ? Date.now() + autosaveMs : null);
    }
  }, [snapshot, autosaveMs]);

  useEffect(() => {
    if (!nextAutosaveAt) return;
    const id = window.setInterval(() => setStatusNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [nextAutosaveAt]);

  // The auto-save loop. Runs on the configured interval (from settings).
  // Disabled entirely when autosaveMs is 0.
  useEffect(() => {
    if (!autosaveMs || !nextAutosaveAt) return;
    const delay = Math.max(0, nextAutosaveAt - Date.now());
    const id = window.setTimeout(() => {
      void triggerAutoSave();
    }, delay);
    return () => window.clearTimeout(id);
  }, [triggerAutoSave, autosaveMs, nextAutosaveAt]);

  // Save immediately when the tab becomes hidden — we don't want to lose
  // the in-flight draft if the user navigates away.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) void triggerAutoSave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [triggerAutoSave]);

  // Esc closes the composer (after saving).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void handleClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleMap: Record<string, string> = {
    new: composeDraftId
      ? t("compose.new")
      : t("compose.new"),
    reply: t("compose.reply"),
    reply_all: t("compose.replyAll"),
    forward: t("compose.forward"),
  };

  const canSend = to.trim().length > 0 && (fromAccountId ?? 0) > 0;
  const toRecipients = parseAddressList(to);

  // --- Attachment handlers ---
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const file of arr) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        showToast(t("compose.fileExceedsLimit", { name: file.name }), "error");
        continue;
      }
      try {
        const data_base64 = await fileToBase64(file);
        setAttachments((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            size: file.size,
            data_base64,
          },
        ]);
      } catch {
        showToast(t("compose.fileReadFailed", { name: file.name }), "error");
      }
    }
  }, [t]);

  // Called by RichTextEditor when a user pastes/inserts an inline image.
  // The editor already inserts the <img src="data:..."> into the DOM;
  // we just register the attachment so it gets sent with the email.
  const handleImageAdd = useCallback((info: InlineImageInfo) => {
    if (info.size > MAX_ATTACHMENT_SIZE) {
      showToast(t("compose.fileExceedsLimit", { name: info.filename }), "error");
      return;
    }
    const comma = info.dataUrl.indexOf(",");
    const data_base64 = comma >= 0 ? info.dataUrl.slice(comma + 1) : info.dataUrl;
    setAttachments((prev) => [
      ...prev,
      {
        id: info.cid,
        filename: info.filename,
        mime_type: info.mimeType,
        size: info.size,
        content_id: info.cid,
        data_base64,
      },
    ]);
  }, [t]);

  const removeAttachment = (id: string) => {
    const att = attachments.find((a) => a.id === id);
    if (att?.content_id) {
      // Remove the inline <img> from the HTML body whose data: URL matches.
      const parser = new DOMParser();
      const doc = parser.parseFromString(body, "text/html");
      const dataUrl = `data:${att.mime_type};base64,${att.data_base64}`;
      doc.querySelectorAll("img").forEach((img) => {
        if (img.getAttribute("src") === dataUrl) img.remove();
      });
      setBody(doc.body.innerHTML);
    }
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files.length > 0) {
        void addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handleSend = async () => {
    if (!canSend) {
      showToast(t("compose.recipientRequired"), "warning");
      return;
    }
    // Parse the HTML body and convert inline data: URLs to cid: references.
    const parser = new DOMParser();
    const doc = parser.parseFromString(body, "text/html");
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("data:")) {
        const match = attachments.find(
          (a) =>
            a.content_id &&
            `data:${a.mime_type};base64,${a.data_base64}` === src,
        );
        if (match?.content_id) {
          img.setAttribute("src", `cid:${match.content_id}`);
        }
      }
    });
    const bodyHtml = doc.body.innerHTML;
    const bodyText = doc.body.textContent || "";

    // PGP encryption
    let finalBodyHtml = bodyHtml;
    let finalBodyText = bodyText;
    if (encryptKeyId) {
      const selectedKey = pgpKeys.find((k) => k.id === encryptKeyId);
      if (selectedKey) {
        try {
          finalBodyHtml = await encryptMessage(bodyHtml, selectedKey.public_key);
          finalBodyText = finalBodyHtml; // encrypted content
        } catch (err) {
          showToast(t("compose.pgpEncryptFailed") + (err instanceof Error ? err.message : t("compose.unknownError")), "error");
          return;
        }
      }
    }

    // Map local attachments to the API shape
    const apiAttachments: AttachmentInput[] = attachments.map((a) => ({
      filename: a.filename,
      mime_type: a.mime_type,
      size: a.size,
      content_id: a.content_id || "",
      data_base64: a.data_base64,
    }));
    try {
      await sendMessage.mutateAsync({
        account_id: fromAccountId!,
        to_addresses: parseAddressList(to),
        cc_addresses: parseAddressList(cc),
        bcc_addresses: parseAddressList(bcc),
        subject,
        body_html: finalBodyHtml,
        body_text: finalBodyText,
        in_reply_to: replyMsg?.message_id ?? "",
        references: replyMsg?.references ?? "",
        attachments: apiAttachments.length > 0 ? apiAttachments : undefined,
      });
      // Successful send → clean up the auto-saved draft if we have one.
      if (draftId) {
        try {
          await permanentDeleteDraft.mutateAsync(draftId);
        } catch {
          /* ignore — the draft is non-critical once the message is sent */
        }
      }
      showToast(t("compose.sent"), "success");
      closeCompose();
    } catch {
      // toast already shown by mutation
    }
  };

  const handleClose = async () => {
    // Force a final save first so no edits are lost, then close.
    await triggerAutoSave(true);
    closeCompose();
  };

  const handleDiscard = async () => {
    const ok = await confirm({
      title: t("compose.discard"),
      description:
        t("compose.discardConfirmBody"),
      confirmText: t("compose.discard"),
      confirmVariant: "error",
      destructive: true,
    });
    if (!ok) return;
    if (draftId) {
      try {
        await deleteDraft.mutateAsync(draftId);
      } catch {
        /* ignore */
      }
    }
    showToast(t("compose.discard"), "success");
    closeCompose();
  };

  const handleSave = async () => {
    const saved = await triggerAutoSave(true);
    showToast(
      saved ? t("compose.saved") : t("compose.nothingToSave"),
      saved ? "success" : "info",
    );
  };

  // --- AI panel handlers ---
  const handleEditorSelectionChange = useCallback(
    (text: string) => {
      setEditorSelection(text);
    },
    [],
  );

  // Close context menu on outside click or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const addSelectionToContext = useCallback(() => {
    if (!editorSelection) return;
    const truncated =
      editorSelection.length > 200
        ? editorSelection.slice(0, 200) + "…"
        : editorSelection;
    setAiContexts((prev) => [
      ...prev,
      { label: truncated, contextText: editorSelection },
    ]);
    showToast(t("ai.contextAdded"), "success");
    setContextMenu(null);
  }, [editorSelection, t]);

  const handleApplySelection = useCallback(
    (text: string) => {
      const handle = editorHandleRef.current;
      if (!handle) return;
      // Convert plain text to simple HTML paragraphs.
      const html = text
        .split("\n")
        .filter(Boolean)
        .map((line) => `<p>${line}</p>`)
        .join("");
      handle.replaceSelection(html);
    },
    [],
  );

  const handleApplyAll = useCallback(
    (text: string) => {
      const html = text
        .split("\n")
        .filter(Boolean)
        .map((line) => `<p>${line}</p>`)
        .join("");
      setBody(html);
    },
    [],
  );

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center animate-fade-in-fast",
        isMobile ? "p-0" : "p-4",
      )}
      style={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isMobile) void handleClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full bg-geist-bg-100 shadow-modal border flex flex-col animate-fade-in",
          isMobile
            ? "h-full rounded-none max-h-full"
            : cn("rounded-geist-md max-h-[92vh]", aiOpen ? "max-w-[1320px]" : "max-w-[960px]"),
        )}
        style={{ borderColor: "var(--geist-border)" }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-4 sm:px-6 h-12 border-b shrink-0"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <h1 className="text-heading-16 flex-1 min-w-0 truncate">{titleMap[composeMode]}</h1>
          <div className="flex items-center gap-1.5 shrink-0">
            <SaveIndicator
              status={saveStatus}
              dirty={dirtyRef.current}
              nextAutosaveAt={nextAutosaveAt}
              now={statusNow}
              autosaveEnabled={autosaveMs > 0}
            />
            <Button
              variant={aiOpen ? "secondary" : "tertiary"}
              size="small"
              leadingIcon={<Sparkles size={14} />}
              onClick={() => setAiOpen(!aiOpen)}
            >
              AI
            </Button>
            <Button
              variant="tertiary"
              size="small"
              leadingIcon={<Trash2 size={14} />}
              onClick={() => void handleDiscard()}
            >
              <span className="hidden sm:inline">{t("compose.discard")}</span>
            </Button>
            <Button
              variant="secondary"
              size="small"
              leadingIcon={<Save size={14} />}
              onClick={() => void handleSave()}
              loading={saveDraft.isPending || updateDraft.isPending}
            >
              <span className="hidden sm:inline">{t("common.save")}</span>
            </Button>
            <Button
              size="small"
              leadingIcon={<Send size={14} />}
              onClick={handleSend}
              loading={sendMessage.isPending}
              disabled={!canSend}
            >
              <span className="hidden sm:inline">{t("compose.send")}</span>
            </Button>
            <button
              onClick={() => void handleClose()}
              aria-label={t("common.close")}
              className="h-8 w-8 flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
        <div className={cn("flex-1 flex flex-col overflow-y-auto min-w-0", isMobile ? "px-4 py-4" : "px-8 py-6")}>
        {/* From */}
        <Field label={t("compose.from")}>
          <select
            className="input w-full"
            value={fromAccountId ?? ""}
            onChange={(e) => setFromAccountId(Number(e.target.value))}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} &lt;{a.email}&gt;
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t("compose.to")}
          trailing={
            <div className="flex items-center gap-1.5 text-label-12">
              {!showCc && (
                <button
                  onClick={() => setShowCc(true)}
                  className="text-secondary hover:text-[var(--geist-primary)]"
                >
                  {t("compose.cc")}
                </button>
              )}
              {!showBcc && (
                <button
                  onClick={() => setShowBcc(true)}
                  className="text-secondary hover:text-[var(--geist-primary)]"
                >
                  {t("compose.bcc")}
                </button>
              )}
            </div>
          }
        >
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="input w-full"
          />
        </Field>
        {toRecipients.length > 1 && (
          <div className="ml-[72px] flex flex-wrap gap-1.5 pt-1">
            {toRecipients.map((recipient) => (
              <span
                key={recipient}
                className="h-6 max-w-[220px] inline-flex items-center rounded-geist border px-2 text-label-12 truncate"
                style={{ borderColor: "var(--geist-border)" }}
              >
                {recipient}
              </span>
            ))}
          </div>
        )}
        {showCc && (
          <Field label={t("compose.cc")}>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="cc@example.com"
              className="input w-full"
            />
          </Field>
        )}
        {showBcc && (
          <Field label={t("compose.bcc")}>
            <input
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              placeholder="bcc@example.com"
              className="input w-full"
            />
          </Field>
        )}
        <Field label={t("compose.subject")}>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t("compose.subject")}
            className="input w-full"
          />
        </Field>
        <div className="pt-4"
          onContextMenu={(e) => {
            if (aiOpen && editorSelection) {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <RichTextEditor
            ref={editorHandleRef}
            value={body}
            onChange={setBody}
            onSelectionChange={handleEditorSelectionChange}
            onImageAdd={handleImageAdd}
            onFilesDrop={(files) => void addFiles(files)}
            dragOverlayText={t("compose.dropToAttach")}
            toolbarExtra={
              <>
              {/* PGP encrypt toggle */}
              <div className="relative">
                <Tooltip content={encryptKeyId ? t("compose.cancelEncrypt") : t("compose.pgpEncrypt")}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (encryptKeyId) {
                        setEncryptKeyId(null);
                      } else {
                        setShowEncryptPicker(!showEncryptPicker);
                      }
                    }}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-geist hover:bg-[var(--geist-bg-200)]"
                    style={{ color: encryptKeyId ? "var(--geist-green-500)" : "var(--geist-secondary)" }}
                  >
                    {encryptKeyId ? <Lock size={14} /> : <Unlock size={14} />}
                  </button>
                </Tooltip>
                {showEncryptPicker && !encryptKeyId && (
                  <div
                    className="absolute top-full left-0 mt-1 z-50 rounded-geist border shadow-lg p-2 min-w-[200px]"
                    style={{ borderColor: "var(--geist-border)", backgroundColor: "var(--geist-bg-100)" }}
                  >
                    {pgpKeys.length === 0 ? (
                      <p className="text-label-12 text-secondary px-2 py-1">
                        {t("compose.noKeysHint")}
                      </p>
                    ) : (
                      pgpKeys.map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          className="w-full text-left px-2 py-1.5 rounded text-label-13 hover:bg-[var(--geist-bg-200)]"
                          onClick={() => {
                            setEncryptKeyId(k.id);
                            setShowEncryptPicker(false);
                          }}
                        >
                          {k.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <Tooltip content={t("settings.attachments.add")}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setAttachOpen(true)}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)] relative"
                  style={{ color: "var(--geist-secondary)" }}
                  aria-label={t("settings.attachments.add")}
                >
                  <Paperclip size={14} />
                  {attachments.length > 0 && (
                    <span
                      className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full text-label-10 font-semibold flex items-center justify-center"
                      style={{
                        backgroundColor: "var(--geist-secondary)",
                        color: "var(--geist-bg-100)",
                      }}
                    >
                      {attachments.length}
                    </span>
                  )}
                </button>
              </Tooltip>
              </>
            }
            placeholder={t("compose.body")}
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.currentTarget.value = "";
          }}
        />
        </div>
        {/* AI writing assistant panel */}
        {aiOpen && (
          <ComposeAIPanel
            contexts={aiContexts}
            onRemoveContext={(idx) =>
              setAiContexts((prev) => prev.filter((_, i) => i !== idx))
            }
            onApplySelection={handleApplySelection}
            onApplyAll={handleApplyAll}
            onClose={() => setAiOpen(false)}
            hasEditorSelection={!!editorSelection}
          />
        )}
        </div>

      {/* Context menu for "Add to AI context" */}
      {contextMenu && createPortal(
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          className="min-w-[160px] py-1 rounded-geist border shadow-popover animate-fade-in-fast"
          style={{
            position: "fixed",
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 80),
            zIndex: 9999,
            backgroundColor: "var(--geist-bg-100)",
            borderColor: "var(--geist-border)",
          }}
        >
          <button
            onClick={addSelectionToContext}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-label-13 text-left hover:bg-[var(--geist-bg-200)] transition-colors"
            style={{ color: "var(--geist-primary)" }}
          >
            <Sparkles size={14} />
            {t("ai.addToContext")}
          </button>
        </div>,
        document.body,
      )}

      {/* Attachment dialog */}
      {attachOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-6 animate-fade-in-fast"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setAttachOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-[520px] rounded-geist-md bg-geist-bg-100 shadow-modal border flex flex-col max-h-[80vh] animate-fade-in"
            style={{ borderColor: "var(--geist-border)" }}
          >
            <div
              className="flex items-center gap-2 px-4 h-12 border-b shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <Paperclip size={15} style={{ color: "var(--geist-primary)" }} />
              <span className="text-label-14 font-semibold flex-1">{t("settings.attachments.title")}</span>
              <span className="text-label-12 text-secondary">{attachments.length === 1 ? t("compose.fileCount", { count: attachments.length }) : t("compose.fileCountPlural", { count: attachments.length })}</span>
              <button
                onClick={() => setAttachOpen(false)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)]"
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {/* Drop zone */}
              <div
                className={cn(
                  "rounded-geist border-2 border-dashed p-6 text-center transition-colors cursor-pointer",
                  dragActive && "border-[var(--geist-primary)] bg-[var(--geist-bg-200)]",
                )}
                style={{
                  borderColor: dragActive ? "var(--geist-primary)" : "var(--geist-border)",
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={24} className="mx-auto mb-2 text-secondary" />
                <p className="text-label-13 text-secondary">
                  {t("settings.attachments.dragDrop")}
                </p>
                <p className="text-label-12 text-disabled mt-1">
                  {t("settings.attachments.maxSize")} · {t("compose.pasteImages")}
                </p>
              </div>
              {/* Attachment list */}
              {attachments.length > 0 && (
                <div className="mt-3 space-y-2">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="inline-flex items-center gap-2 h-9 w-full rounded-geist border px-3 text-label-12"
                      style={{ borderColor: "var(--geist-border)" }}
                    >
                      {att.content_id ? <ImageIcon size={14} /> : <FileIcon size={14} />}
                      <span className="truncate flex-1">{att.filename}</span>
                      <span className="text-secondary shrink-0">{formatBytes(att.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        className="shrink-0 text-secondary hover:text-[var(--geist-red-500)]"
                        aria-label={t("settings.attachments.remove")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>,
    document.body,
  );
}

function SaveIndicator({
  status,
  dirty,
  nextAutosaveAt,
  now,
  autosaveEnabled,
}: {
  status: SaveStatus;
  dirty: boolean;
  nextAutosaveAt: number | null;
  now: number;
  autosaveEnabled: boolean;
}) {
  const { t } = useTranslation();
  if (status.kind === "idle") {
    const secondsLeft =
      dirty && autosaveEnabled && nextAutosaveAt
        ? Math.max(0, Math.ceil((nextAutosaveAt - now) / 1000))
        : null;
    return (
      <span
        className="inline-flex items-center gap-1 text-label-12"
        style={{ color: "var(--geist-tertiary)" }}
        title={
          secondsLeft === null
            ? t("compose.unsaved")
            : t("compose.autosaveCountdown", { seconds: secondsLeft })
        }
      >
        <CircleDashed size={12} />
        {secondsLeft === null
          ? t("compose.unsaved")
          : t("compose.autosaveCountdown", { seconds: secondsLeft })}
      </span>
    );
  }
  if (status.kind === "saving") {
    return (
      <span
        className="inline-flex items-center gap-1 text-label-12"
        style={{ color: "var(--geist-tertiary)" }}
      >
        <CircleDashed size={12} className="spinner" />
        {t("compose.autosaving")}
      </span>
    );
  }
  if (status.kind === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-label-12"
        style={{ color: "var(--geist-red-500)" }}
        title={status.message}
      >
        <AlertCircle size={12} />
        {t("compose.unsaved")}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-label-12"
      style={{ color: "var(--geist-tertiary)" }}
      title={new Date(status.at).toLocaleString()}
    >
      <Check size={12} />
      {t("compose.savedAt", { when: formatRelative(status.at) })}
    </span>
  );
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function Field({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className="grid items-center gap-2 sm:gap-3 py-2.5 border-b grid-cols-1 sm:grid-cols-[60px_1fr]"
      style={{ borderColor: "var(--geist-border)" }}
    >
      <span className="text-label-13 text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <div className="flex-1">{children}</div>
        {trailing}
      </div>
    </div>
  );
}

/* ----------------- helpers ----------------- */

function serializeForm(form: {
  accountId: number | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}): string {
  return JSON.stringify(form);
}

function serializeSnapshot(d: {
  account_id?: number | null;
  to_addresses: string;
  cc_addresses?: string;
  bcc_addresses?: string;
  subject: string;
  body_text?: string;
  body_html?: string;
  updated_at?: string;
}): string {
  return JSON.stringify({
    accountId: d.account_id ?? null,
    to: addressListToString(d.to_addresses),
    cc: addressListToString(d.cc_addresses || ""),
    bcc: addressListToString(d.bcc_addresses || ""),
    subject: d.subject || "",
    body:
      d.body_text ||
      (d.body_html || "").replace(/<br\s*\/?>/gi, "\n"),
  });
}

function addressListToString(raw: string): string {
  if (!raw) return "";
  // Stored as JSON-encoded array of {name?, address}. We collapse to a
  // comma-separated string for the input field.
  try {
    const arr = JSON.parse(raw) as Array<{ name?: string; address: string }>;
    if (!Array.isArray(arr)) return raw;
    return arr
      .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
      .join(", ");
  } catch {
    return raw;
  }
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
