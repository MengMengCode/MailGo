import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { Bot, Loader2, SendHorizontal, X, GripHorizontal } from "lucide-react";
import { aiApi } from "@/lib/api";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { useAppStore } from "@/stores/appStore";
import { showToast } from "@/stores/toast.store";
import { isAIGlobalConfigured } from "@/lib/aiConfigCheck";
import { cn } from "@/lib/utils";

type ChatRole = "assistant" | "user";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  createdAt: number;
};

export interface MiniChatContext {
  /** A label shown in the header describing what's attached (e.g. "3 封邮件"). */
  label: string;
  /**
   * Returns the context text to inject into the system prompt. If `null`,
   * no permission is needed to *read* (text was already provided). If it
   * returns a string, the caller has already fetched the data.
   */
  contextText: string;
}

interface AIMiniChatProps {
  /** Describes the attached context (selected text, selected emails, etc.). */
  context: MiniChatContext;
  /** Called when the user clicks the X button. */
  onClose: () => void;
  /** Optional initial prompt to auto-send immediately. */
  initialPrompt?: string;
}

export function AIMiniChat({ context, onClose, initialPrompt }: AIMiniChatProps) {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const openCompose = useAppStore((s) => s.openCompose);

  const aiConfig = useSettingsAIConfig(settings);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    makeMsg("assistant", t("ai.systemPromptMini")),
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  // --- Draggable window state ---
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, window.innerWidth - 432),
    y: 96,
  }));
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const x = Math.max(8, Math.min(window.innerWidth - 400, e.clientX - dragOffset.current.x));
    const y = Math.max(8, Math.min(window.innerHeight - 80, e.clientY - dragOffset.current.y));
    setPos({ x, y });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const updateMsg = useCallback((id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
  }, []);

  const send = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || loading) return;
    if (!isAIGlobalConfigured(settings)) {
      showToast(t("ai.notConfigured"), "warning");
      return;
    }
    setMessages((prev) => [...prev, makeMsg("user", text)]);
    setInput("");
    setLoading(true);
    const assistantMsg = makeMsg("assistant", "");
    setMessages((prev) => [...prev, assistantMsg]);

    // Check if the user is asking to draft/compose — that needs permission.
    const wantsDraft = /起草|撰写|回复|draft|compose|reply|写.{0,4}邮件/i.test(text);

    try {
      if (wantsDraft) {
        showToast(t("ai.draftConfirm"), "info");
        // Still let AI generate the draft text, then open compose.
      }
      await runAIBufferedMini(
        aiConfig,
        context.contextText,
        text,
        assistantMsg.id,
        updateMsg,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("ai.aiRequestFailed"), "error");
      updateMsg(assistantMsg.id, (m) => ({
        ...m,
        content: m.content || t("ai.aiNoContent"),
      }));
    } finally {
      setLoading(false);
    }
  }, [aiConfig, context.contextText, loading, updateMsg]);

  // Auto-send the initial prompt if provided (e.g. "翻译这段文字").
  const sentInitial = useRef(false);
  useEffect(() => {
    if (initialPrompt && !sentInitial.current && !loading) {
      sentInitial.current = true;
      void send(initialPrompt);
    }
  }, [initialPrompt, send, loading]);

  const streaming = loading && messages[messages.length - 1]?.role === "assistant";

  return (
    <div
      className="fixed flex flex-col rounded-geist-md border shadow-modal animate-fade-in-fast"
      style={{
        left: pos.x,
        top: pos.y,
        width: 400,
        height: 460,
        zIndex: 10000,
        backgroundColor: "var(--geist-bg-100)",
        borderColor: "var(--geist-border)",
      }}
    >
      {/* Draggable header */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex items-center gap-2 px-3 h-10 border-b shrink-0 cursor-grab active:cursor-grabbing"
        style={{ borderColor: "var(--geist-border)" }}
      >
        <GripHorizontal size={13} className="text-secondary shrink-0" />
        <Bot size={14} style={{ color: "var(--geist-primary)" }} />
        <span className="text-label-13 font-semibold truncate flex-1">{t("ai.assistant")}</span>
        <span
          className="text-label-11 px-1.5 h-5 inline-flex items-center rounded-full shrink-0"
          style={{
            backgroundColor: "color-mix(in srgb, var(--geist-primary) 10%, transparent)",
            color: "var(--geist-primary)",
          }}
        >
          {context.label}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)] hover:text-[var(--geist-primary)] shrink-0"
          aria-label={t("common.close")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-2 scroll-region">
        <div className="space-y-3">
          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            const isStreaming = streaming && isLast && msg.role === "assistant";
            return <MiniBubble key={msg.id} message={msg} streaming={isStreaming} />;
          })}
          {loading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex items-center gap-1.5 text-label-12 text-secondary">
              <Loader2 size={12} className="spinner" /> {t("ai.thinking")}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t px-3 pb-3 pt-2" style={{ borderColor: "var(--geist-border)" }}>
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
            placeholder={t("ai.inputPlaceholder")}
            className="w-full resize-none bg-transparent outline-none text-[13px] px-3.5 pt-2.5 pb-0 placeholder:text-[var(--geist-disabled)] leading-relaxed"
            style={{ minHeight: "20px", maxHeight: "120px" }}
          />
          <div className="flex items-center justify-end px-2.5 py-1.5">
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() || loading}
              className="h-7 w-7 inline-flex items-center justify-center rounded-full disabled:opacity-30 text-white transition-all hover:opacity-90"
              style={{
                background: !input.trim() || loading
                  ? "var(--geist-bg-200)"
                  : "linear-gradient(135deg, var(--geist-primary), var(--geist-blue-500, #0070f3))",
                color: !input.trim() || loading ? "var(--geist-disabled)" : "white",
              }}
              aria-label={t("ai.send")}
            >
              {loading ? <Loader2 size={13} className="spinner" /> : <SendHorizontal size={13} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
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
        className="h-6 w-6 rounded-full inline-flex items-center justify-center shrink-0"
        style={{ backgroundColor: "var(--geist-primary)", color: "var(--geist-bg-100)" }}
      >
        <Bot size={12} />
      </div>
      <div
        className="flex-1 min-w-0 text-copy-13 leading-relaxed ai-markdown"
        style={{ color: "var(--geist-primary)" }}
        dangerouslySetInnerHTML={{
          __html: renderMarkdownMini(message.content) + (streaming ? '<span class="ai-cursor"></span>' : ""),
        }}
      />
    </div>
  );
}

// --- Helpers ---

function makeMsg(role: ChatRole, content: string): ChatMessage {
  return { id: makeID(), role, content, createdAt: Date.now() };
}

function makeID() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function useSettingsAIConfig(settings: { key: string; value: string }[]) {
  return {
    model: settings.find((s) => s.key === "ai_model")?.value || "gpt-4o-mini",
  };
}

/**
 * runAIBufferedMini streams an AI response with rAF-batched state updates
 * for smooth rendering. `contextText` is injected as a system message so
 * the AI has the selected text / emails as context.
 */
async function runAIBufferedMini(
  config: { model: string },
  contextText: string,
  userPrompt: string,
  msgId: string,
  updateMsg: (id: string, updater: (m: ChatMessage) => ChatMessage) => void,
) {
  let contentBuf = "";
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (contentBuf) {
      const c = contentBuf;
      contentBuf = "";
      updateMsg(msgId, (m) => ({ ...m, content: m.content + c }));
    }
  };
  const scheduleFlush = () => {
    if (rafId === null) rafId = requestAnimationFrame(flush);
  };

  try {
    const result = await runAIMini(
      config,
      contextText,
      userPrompt,
      (chunk) => {
        contentBuf += chunk;
        scheduleFlush();
      },
    );
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flush();
    return result;
  } catch (err) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flush();
    throw err;
  }
}

async function runAIMini(
  config: { model: string },
  contextText: string,
  userPrompt: string,
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const response = await aiApi.agentStream({
    model: config.model,
    messages: [
      {
        role: "system",
        content: i18n.t("ai.languageInstruction"),
      },
      {
        role: "user",
        content: `${i18n.t("ai.referenceContext")}\n${contextText}\n\n${i18n.t("ai.userQuestion")}${userPrompt}`,
      },
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
  let accumulated = "";
  let currentEvent = "message";

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
          accumulated += parsed.text;
          onDelta?.(parsed.text);
        } else if (currentEvent === "error") {
          throw new Error(parsed.message || "AI error");
        }
        // Ignore reasoning, tool_call, tool_result, step, done events
      } catch (e) {
        if (e instanceof Error && e.message !== "AI error" && !e.message.startsWith("HTTP")) {
          // Skip malformed JSON
        } else if (e instanceof Error) {
          throw e;
        }
      }
      currentEvent = "message";
    }
  }

  return accumulated || i18n.t("ai.aiNoContent");
}

function renderMarkdownMini(md: string): string {
  if (!md) return "";
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = html.split("\n");
  const out: string[] = [];
  let inUl = false;

  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const separatorIndex = isMiniTableRow(line) ? nextMiniNonEmptyLineIndex(lines, i + 1) : -1;
    if (isMiniTableRow(line) && separatorIndex >= 0 && isMiniTableSeparator(lines[separatorIndex])) {
      closeList();
      const header = parseMiniTableRow(line);
      const bodyRows: string[][] = [];
      i = separatorIndex + 1;
      while (i < lines.length) {
        if (lines[i].trim() === "") {
          const nextRowIndex = nextMiniNonEmptyLineIndex(lines, i + 1);
          if (nextRowIndex >= 0 && isMiniTableRow(lines[nextRowIndex])) {
            i = nextRowIndex;
          } else {
            break;
          }
        }
        if (!isMiniTableRow(lines[i])) break;
        bodyRows.push(parseMiniTableRow(lines[i]));
        i += 1;
      }
      i--;
      out.push(renderMiniTable(header, bodyRows));
      continue;
    }

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

function nextMiniNonEmptyLineIndex(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

function isMiniTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !trimmed.startsWith("<");
}

function isMiniTableSeparator(line: string): boolean {
  const cells = parseMiniTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMiniTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderMiniTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const renderCells = (cells: string[], tag: "th" | "td") =>
    Array.from({ length: width }, (_, index) => `<${tag}>${cells[index] || ""}</${tag}>`).join("");
  const body = rows.map((row) => `<tr>${renderCells(row, "td")}</tr>`).join("");
  return `<table><thead><tr>${renderCells(header, "th")}</tr></thead><tbody>${body}</tbody></table>`;
}

