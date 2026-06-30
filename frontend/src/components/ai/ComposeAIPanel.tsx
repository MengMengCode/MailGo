import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import {
  Bot,
  Loader2,
  SendHorizontal,
  X,
  Replace,
  FileText,
  Paperclip,
} from "lucide-react";
import { aiApi } from "@/lib/api";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { isAIGlobalConfigured } from "@/lib/aiConfigCheck";
import { showToast } from "@/stores/toast.store";

type ChatRole = "assistant" | "user";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export interface ComposeAIContext {
  label: string;
  contextText: string;
}

interface ComposeAIPanelProps {
  /** Context snippets attached by the user (selected text, etc.). */
  contexts: ComposeAIContext[];
  /** Remove a context by index. */
  onRemoveContext: (index: number) => void;
  /** Apply AI text as replacement for editor selection. */
  onApplySelection: (text: string) => void;
  /** Replace the entire editor body. */
  onApplyAll: (text: string) => void;
  /** Close the AI panel. */
  onClose: () => void;
  /** Whether the editor currently has a text selection. */
  hasEditorSelection: boolean;
}

function makeMsg(role: ChatRole, content: string): ChatMessage {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, content, createdAt: Date.now() };
}

function useSettingsAIConfig(settings: { key: string; value: string }[]) {
  return {
    model: settings.find((s) => s.key === "ai_model")?.value || "gpt-4o-mini",
  };
}

export function ComposeAIPanel({
  contexts,
  onRemoveContext,
  onApplySelection,
  onApplyAll,
  onClose,
  hasEditorSelection,
}: ComposeAIPanelProps) {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const aiConfig = useSettingsAIConfig(settings);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }, [input]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const updateMsg = useCallback(
    (id: string, updater: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    },
    [],
  );

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || loading) return;

      if (!isAIGlobalConfigured(settings)) {
        showToast(t("ai.notConfigured"), "warning");
        return;
      }

      // Build context string from attached snippets.
      const contextBlock =
        contexts.length > 0
          ? contexts.map((c) => `[${c.label}]\n${c.contextText}`).join("\n\n")
          : "";

      setMessages((prev) => [...prev, makeMsg("user", text)]);
      setInput("");
      setLoading(true);
      const assistantMsg = makeMsg("assistant", "");
      setMessages((prev) => [...prev, assistantMsg]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const userContent = contextBlock
          ? `${i18n.t("ai.referenceContext")}\n${contextBlock}\n\n${i18n.t("ai.userQuestion")}${text}`
          : text;

        const response = await aiApi.agentStream({
          model: aiConfig.model,
          messages: [
            { role: "system", content: t("ai.composeSystemPrompt") },
            { role: "system", content: t("ai.languageInstruction") },
            { role: "user", content: userContent },
          ],
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        let buffer = "";
        let contentBuf = "";
        let rafId: number | null = null;
        let currentEvent = "message";

        const flush = () => {
          rafId = null;
          if (contentBuf) {
            const c = contentBuf;
            contentBuf = "";
            updateMsg(assistantMsg.id, (m) => ({ ...m, content: m.content + c }));
          }
        };
        const scheduleFlush = () => {
          if (rafId === null) rafId = requestAnimationFrame(flush);
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (trimmed.startsWith("event:")) {
                currentEvent = trimmed.slice(6).trim();
                continue;
              }
              if (!trimmed.startsWith("data:")) continue;

              const data = trimmed.slice(5).trim();
              try {
                const parsed = JSON.parse(data);
                if (currentEvent === "content" && parsed.text) {
                  contentBuf += parsed.text;
                  scheduleFlush();
                } else if (currentEvent === "error") {
                  throw new Error(parsed.message || "AI error");
                }
              } catch (e) {
                if (
                  e instanceof Error &&
                  e.message !== "AI error" &&
                  !e.message.startsWith("HTTP")
                ) {
                  /* skip malformed JSON */
                } else if (e instanceof Error) {
                  throw e;
                }
              }
              currentEvent = "message";
            }
          }
        } finally {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
          }
          flush();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        updateMsg(assistantMsg.id, (m) => ({
          ...m,
          content: m.content || t("ai.aiNoContent"),
        }));
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [aiConfig, contexts, loading, updateMsg, t],
  );

  const stopGeneration = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  return (
    <div
      className="flex flex-col border-l h-full"
      style={{
        borderColor: "var(--geist-border)",
        backgroundColor: "var(--geist-bg-100)",
        width: 360,
        minWidth: 360,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 h-10 border-b shrink-0"
        style={{ borderColor: "var(--geist-border)" }}
      >
        <Bot size={14} className="shrink-0" style={{ color: "var(--geist-primary)" }} />
        <span className="text-label-13 font-semibold truncate flex-1">
          {t("ai.composeAssistant")}
        </span>
        {contexts.length > 0 && (
          <span
            className="text-label-11 px-1.5 h-5 inline-flex items-center rounded-full shrink-0"
            style={{
              backgroundColor: "color-mix(in srgb, var(--geist-primary) 10%, transparent)",
              color: "var(--geist-primary)",
            }}
          >
            {t("ai.contextCount", { count: contexts.length })}
          </span>
        )}
        <button
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)] hover:text-[var(--geist-primary)] shrink-0"
          aria-label={t("common.close")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-2 scroll-region">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 opacity-50">
            <Bot size={28} className="mb-2" style={{ color: "var(--geist-secondary)" }} />
            <p className="text-label-13" style={{ color: "var(--geist-secondary)" }}>
              {t("ai.composePlaceholder")}
            </p>
            {contexts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 justify-center">
                {contexts.map((ctx, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-label-11 max-w-full"
                    style={{
                      backgroundColor: "color-mix(in srgb, var(--geist-primary) 8%, transparent)",
                      color: "var(--geist-primary)",
                    }}
                  >
                    <Paperclip size={10} className="shrink-0" />
                    <span className="truncate">{ctx.label}</span>
                    <button
                      onClick={() => onRemoveContext(idx)}
                      className="shrink-0 hover:opacity-60 transition-opacity"
                      aria-label={t("ai.removeContext")}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="space-y-3">
          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            const isStreaming = loading && isLast && msg.role === "assistant";
            return (
              <ComposeBubble
                key={msg.id}
                message={msg}
                streaming={isStreaming}
                onApplySelection={
                  msg.role === "assistant" && msg.content
                    ? () => onApplySelection(msg.content)
                    : undefined
                }
                onApplyAll={
                  msg.role === "assistant" && msg.content
                    ? () => onApplyAll(msg.content)
                    : undefined
                }
                hasEditorSelection={hasEditorSelection}
              />
            );
          })}
          {loading && messages[messages.length - 1]?.role === "user" && (
            <div
              className="flex items-center gap-1.5 text-label-12"
              style={{ color: "var(--geist-secondary)" }}
            >
              <Loader2 size={12} className="spinner" /> {t("ai.thinking")}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div
        className="shrink-0 border-t px-3 pb-3 pt-2"
        style={{ borderColor: "var(--geist-border)" }}
      >
        <div
          className="rounded-[14px] border shadow-sm overflow-hidden transition-shadow focus-within:shadow-md"
          style={{
            borderColor: "var(--geist-border)",
            backgroundColor: "var(--geist-bg-100)",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder={t("ai.composePlaceholder")}
            className="w-full resize-none bg-transparent outline-none text-[13px] px-3.5 pt-2.5 pb-0 placeholder:text-[var(--geist-disabled)] leading-relaxed"
            style={{ minHeight: "20px", maxHeight: "100px" }}
          />
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="text-label-11" style={{ color: "var(--geist-gray-500)" }}>
              {contexts.length > 0
                ? t("ai.contextCount", { count: contexts.length })
                : ""}
            </span>
            <div className="flex items-center gap-1">
              {loading && (
                <button
                  onClick={stopGeneration}
                  className="h-6 px-2 inline-flex items-center justify-center rounded-full text-label-11"
                  style={{
                    backgroundColor: "var(--geist-red-100)",
                    color: "var(--geist-red-500)",
                  }}
                >
                  {t("ai.stop")}
                </button>
              )}
              <button
                onClick={() => void send(input)}
                disabled={!input.trim() || loading}
                className="h-7 w-7 inline-flex items-center justify-center rounded-full disabled:opacity-30 text-white transition-all hover:opacity-90"
                style={{
                  background:
                    !input.trim() || loading
                      ? "var(--geist-bg-200)"
                      : "linear-gradient(135deg, var(--geist-primary), var(--geist-blue-500, #0070f3))",
                  color:
                    !input.trim() || loading
                      ? "var(--geist-disabled)"
                      : "white",
                }}
                aria-label={t("ai.send")}
              >
                {loading ? (
                  <Loader2 size={13} className="spinner" />
                ) : (
                  <SendHorizontal size={13} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Message bubble ───────────────────────────────────────────────────── */

function ComposeBubble({
  message,
  streaming,
  onApplySelection,
  onApplyAll,
  hasEditorSelection,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onApplySelection?: () => void;
  onApplyAll?: () => void;
  hasEditorSelection?: boolean;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[80%] rounded-[14px] rounded-br-[5px] px-3 py-2 text-copy-13 whitespace-pre-wrap"
          style={{
            backgroundColor: "var(--geist-primary)",
            color: "var(--geist-bg-100)",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <div
        className="h-6 w-6 rounded-full inline-flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: "var(--geist-primary)", color: "var(--geist-bg-100)" }}
      >
        <Bot size={12} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-copy-13 leading-relaxed ai-markdown"
          style={{ color: "var(--geist-primary)" }}
          dangerouslySetInnerHTML={{
            __html:
              renderMarkdownCompose(message.content) +
              (streaming ? '<span class="ai-cursor"></span>' : ""),
          }}
        />
        {/* Action buttons — only on completed assistant messages */}
        {onApplySelection && onApplyAll && !streaming && message.content && (
          <div className="flex items-center gap-1.5 mt-2">
            {hasEditorSelection && (
              <button
                onClick={onApplySelection}
                className="h-6 px-2 inline-flex items-center gap-1 rounded-full text-label-11 font-medium hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: "var(--geist-bg-200)",
                  color: "var(--geist-primary)",
                  border: "1px solid var(--geist-border)",
                }}
              >
                <Replace size={11} />
                {t("ai.replaceSelection")}
              </button>
            )}
            <button
              onClick={onApplyAll}
              className="h-6 px-2 inline-flex items-center gap-1 rounded-full text-label-11 font-medium hover:opacity-80 transition-opacity"
              style={{
                backgroundColor: "var(--geist-bg-200)",
                color: "var(--geist-primary)",
                border: "1px solid var(--geist-border)",
              }}
            >
              <FileText size={11} />
              {t("ai.replaceAll")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Markdown renderer (adapted from AIMiniChat) ──────────────────────── */

function renderMarkdownCompose(md: string): string {
  if (!md) return "";
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  const lines = html.split("\n");
  const out: string[] = [];
  let inUl = false;

  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };

  for (const line of lines) {
    const bullet = line.match(/^[-*] (.+)/);
    if (bullet) {
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "" || /^<(table|strong|code)/.test(line.trim())) {
      out.push(line);
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}
