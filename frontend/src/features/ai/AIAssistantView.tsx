import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import {
  Bot,
  ChevronRight,
  Loader2,
  MailOpen,
  Menu,
  MessageSquare,
  PenLine,
  Plus,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
  MailSearch,
  X,
} from "lucide-react";
import { aiApi, messagesApi, type Message } from "@/lib/api";
import { useSettingsQuery } from "@/hooks/queries/useSettings";
import { useAppStore } from "@/stores/appStore";
import { showToast } from "@/stores/toast.store";
import { cn, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { isAIGlobalConfigured } from "@/lib/aiConfigCheck";
import { useIsMobile } from "@/hooks/useBreakpoint";

/* ==========================================================================
   Types
   ========================================================================== */

type ChatRole = "assistant" | "user";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  contextSummary?: string;
  selectedEmailIds?: number[];
  createdAt: number;
};

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

/* ==========================================================================
   Constants
   ========================================================================== */

const HISTORY_KEY = "mailgo-ai-chat-history";

/* ==========================================================================
   Main Component
   ========================================================================== */

export function AIAssistantView() {
  const { t } = useTranslation();
  const { data: settings = [] } = useSettingsQuery();
  const setSelectedMessageId = useAppStore((s) => s.setSelectedMessageId);
  const isMobile = useIsMobile();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerMessages, setPickerMessages] = useState<Message[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const WELCOME_MESSAGE = t("ai.systemPrompt");
  const SUGGESTIONS = useMemo(() => [
    { icon: <MailSearch size={14} />, label: t("ai.quickAction1") },
    { icon: <Sparkles size={14} />, label: t("ai.quickAction2") },
    { icon: <PenLine size={14} />, label: t("ai.quickAction3") },
    { icon: <RotateCcw size={14} />, label: t("ai.quickAction4") },
  ], [t]);

  const aiConfig = useMemo(() => {
    const get = (key: string) => settings.find((s) => s.key === key)?.value || "";
    return { model: get("ai_model") || "gpt-4o-mini" };
  }, [settings]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];

  // Only the welcome message → show the landing screen
  const showLanding =
    activeSession &&
    activeSession.messages.length === 1 &&
    activeSession.messages[0].role === "assistant" &&
    activeSession.messages[0].content === WELCOME_MESSAGE;

  /* ---- Persistence ---- */
  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions));
  }, [sessions]);

  /* ---- Auto-scroll ---- */
  const scrollToBottom = useCallback(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [activeSession?.messages, loading, scrollToBottom]);

  /* ---- Auto-resize textarea ---- */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  /* ---- Session helpers ---- */
  const updateSession = (id: string, updater: (s: ChatSession) => ChatSession) => {
    setSessions((prev) =>
      prev
        .map((s) => (s.id === id ? updater(s) : s))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  };

  const createSession = () => {
    const session = createEmptySession(t("ai.newChat"));
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setInput("");
  };

  const deleteSession = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId) {
        const fallback = next[0] ?? createEmptySession(t("ai.newChat"));
        setActiveId(fallback.id);
        return next.length ? next : [fallback];
      }
      return next.length ? next : [createEmptySession(t("ai.newChat"))];
    });
  };

  const appendMessage = (sessionId: string, message: ChatMessage) => {
    updateSession(sessionId, (s) => ({
      ...s,
      title:
        s.title === t("ai.newChat") && message.role === "user"
          ? titleFromPrompt(message.content, t("ai.newChat"))
          : s.title,
      updatedAt: Date.now(),
      messages: [...s.messages, message],
    }));
  };

  const updateMessage = (sessionId: string, msgId: string, updater: (m: ChatMessage) => ChatMessage) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, updatedAt: Date.now(), messages: s.messages.map((m) => (m.id === msgId ? updater(m) : m)) }
          : s,
      ),
    );
  };

  const removeMessage = (sessionId: string, msgId: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, updatedAt: Date.now(), messages: s.messages.filter((m) => m.id !== msgId) }
          : s,
      ),
    );
  };

  /* ---- Abort ---- */
  const stopGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  };

  /* ---- Send ---- */
  const sendPrompt = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || !activeSession || loading) return;
    if (!isAIGlobalConfigured(settings)) {
      showToast(t("ai.notConfigured"), "warning");
      return;
    }
    const sessionId = activeSession.id;
    const shouldGenerateTitle =
      activeSession.title === t("ai.newChat") &&
      activeSession.messages.every(
        (message) =>
          message.role === "assistant" && message.content === WELCOME_MESSAGE,
      );

    // Capture current selection before clearing
    const emailIds = [...selectedIds];
    const userMsg = createMessage("user", text);
    if (emailIds.length > 0) {
      userMsg.selectedEmailIds = emailIds;
    }
    appendMessage(sessionId, userMsg);
    setInput("");
    // Clear selection after attaching to message
    setSelectedIds([]);
    setSelectedMessageId(null);
    setLoading(true);

    const assistantMsg = createMessage("assistant", "");
    appendMessage(sessionId, assistantMsg);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Build message history for the API call
      const currentSession = sessions.find((s) => s.id === sessionId) ?? activeSession;
      const apiMessages = [
        ...currentSession.messages.filter(
          (m) => !(m.role === "assistant" && !m.content.trim() && m.id !== assistantMsg.id),
        ),
        createMessage(
          "user",
          emailIds.length > 0 ? `${text}\n\n${t("ai.contextPrefix")}${emailIds.join(", ")}` : text,
        ),
      ];

      const cleaned = apiMessages.filter(
        (m) => !(m.role === "assistant" && !m.content.trim()),
      );

      // Prepend language instruction as system message
      const withLang = [
        { role: "system" as const, content: t("ai.languageInstruction") },
        ...cleaned.map((m) => ({
          role: m.role,
          content: m.content,
          context_summary: m.contextSummary,
        })),
      ];

      const response = await aiApi.agentStream({
        model: aiConfig.model,
        messages: withLang,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      // Stream SSE tokens — new event-based format from real-time agent
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let accumulatedThinking = "";
      let currentEvent = "message"; // default SSE event type

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Parse SSE event type
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
            continue;
          }
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();

          try {
            const parsed = JSON.parse(data);

            switch (currentEvent) {
              case "context":
                if (parsed.compacted && parsed.summary) {
                  const checkpoint = cleaned[parsed.checkpoint_index];
                  if (checkpoint) {
                    updateMessage(sessionId, checkpoint.id, (m) => ({
                      ...m,
                      contextSummary: parsed.summary,
                    }));
                  }
                  accumulatedThinking += `\n\n${t("ai.contextCompacted", { tokens: parsed.context_window })}`;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    thinking: accumulatedThinking,
                  }));
                }
                break;

              case "reasoning":
                // Thinking/reasoning delta from the model
                if (parsed.text) {
                  accumulatedThinking += parsed.text;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    thinking: accumulatedThinking,
                  }));
                  scrollToBottom();
                }
                break;

              case "content":
                // Main content delta
                if (parsed.text) {
                  accumulated += parsed.text;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    content: accumulated,
                  }));
                  scrollToBottom();
                }
                break;

              case "tool_call":
                // Tool call started — show status in thinking block
                if (parsed.name && parsed.status === "running") {
                  const toolLabel =
                    parsed.name === "mail_access"
                      ? t("ai.emailReadTool")
                      : parsed.name === "draft_create"
                        ? t("ai.draftCreateTool")
                        : t("ai.toolCalling", { name: parsed.name });
                  accumulatedThinking += `\n\n${toolLabel}`;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    thinking: accumulatedThinking,
                  }));
                  scrollToBottom();
                }
                break;

              case "tool_result":
                // Tool result received
                if (parsed.name) {
                  const resultLabel =
                    parsed.name === "mail_access"
                      ? t("ai.emailReadDone")
                      : parsed.name === "draft_create"
                        ? t("ai.draftCreateDone")
                        : t("ai.toolDone", { name: parsed.name });
                  accumulatedThinking += `\n${resultLabel}`;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    thinking: accumulatedThinking,
                  }));
                }
                break;

              case "error":
                throw new Error(parsed.message || "AI error");

              case "done":
                // Stream complete
                break;

              default:
                // Handle legacy format: raw OpenAI SSE chunks (no event: field)
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  accumulated += delta.content;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    content: accumulated,
                  }));
                  scrollToBottom();
                }
                if (delta?.reasoning_content) {
                  accumulatedThinking += delta.reasoning_content;
                  updateMessage(sessionId, assistantMsg.id, (m) => ({
                    ...m,
                    thinking: accumulatedThinking,
                  }));
                  scrollToBottom();
                }
                break;
            }

            // Reset event type after processing
            currentEvent = "message";
          } catch {
            // Skip malformed SSE chunks
          }
        }
      }

      if (!accumulated) {
        updateMessage(sessionId, assistantMsg.id, (m) => ({
          ...m,
          content: m.content || t("ai.aiNoContent"),
        }));
      }
      if (shouldGenerateTitle) {
        void aiApi
          .title({
            model: aiConfig.model,
            prompt: text,
            response: accumulated,
          })
          .then(({ title }) => {
            if (!title.trim()) return;
            updateSession(sessionId, (session) => ({
              ...session,
              title: title.trim(),
              updatedAt: Date.now(),
            }));
          })
          .catch(() => {
            // Keep the local prompt-derived fallback title.
          });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // User cancelled — keep whatever content was accumulated
        const current = sessions
          .find((s) => s.id === sessionId)
          ?.messages.find((m) => m.id === assistantMsg.id);
        if (!current?.content) {
          removeMessage(sessionId, assistantMsg.id);
        }
        return;
      }
      removeMessage(sessionId, assistantMsg.id);
      showToast(err instanceof Error ? err.message : t("ai.aiRequestFailed"), "error");
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  /* ---- Message picker ---- */
  const openPicker = async () => {
    setPickerOpen(true);
    setPickerQuery("");
    setPickerLoading(true);
    try {
      const res = await messagesApi.list({ page: 1, page_size: 50 });
      setPickerMessages(res.messages);
    } catch {
      showToast(t("ai.loadEmailsFailed"), "error");
    } finally {
      setPickerLoading(false);
    }
  };

  const searchPicker = async (q: string) => {
    setPickerQuery(q);
    setPickerLoading(true);
    try {
      const res = await messagesApi.list({ q: q || undefined, page: 1, page_size: 50 });
      setPickerMessages(res.messages);
    } catch {
      /* ignore */
    } finally {
      setPickerLoading(false);
    }
  };

  const togglePickMessage = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const pickDone = () => {
    setPickerOpen(false);
    if (selectedIds.length > 0) {
      setSelectedMessageId(selectedIds[0]);
      showToast(t("ai.selectedCount", { count: selectedIds.length }), "success");
    }
  };

  if (!activeSession) return null;

  /* Sidebar content — shared between mobile drawer and desktop inline. */
  const sidebarInner = (
    <>
      <div className="p-3">
        <button
          onClick={createSession}
          className="h-10 w-full inline-flex items-center gap-2 rounded-[10px] border px-3 text-[13px] font-medium hover:bg-[var(--geist-bg-100)] transition-colors"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <Plus size={15} />
          {t("ai.newChat")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {sessions.map((session) => (
          <div key={session.id} className="group relative">
            <button
              onClick={() => {
                setActiveId(session.id);
                setHistoryOpen(false);
              }}
              className={cn(
                "w-full h-10 rounded-[10px] px-2.5 pr-9 flex items-center gap-2 text-left text-[13px] transition-colors",
                session.id === activeSession.id
                  ? "bg-[var(--geist-bg-100)] text-[var(--geist-primary)] font-medium shadow-sm"
                  : "text-[var(--geist-secondary)] hover:bg-[var(--geist-bg-100)] hover:text-[var(--geist-primary)]",
              )}
            >
              <MessageSquare size={14} className="shrink-0 opacity-60" />
              <span className="truncate">{session.title}</span>
            </button>
            <button
              onClick={() => void deleteSession(session.id)}
              className="absolute right-1 top-1 h-8 w-8 hidden group-hover:inline-flex items-center justify-center rounded-[8px] text-[var(--geist-secondary)] hover:text-[var(--geist-red-500)] hover:bg-[var(--geist-bg-100)]"
              aria-label={t("ai.deleteChat")}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="h-full flex overflow-hidden" style={{ backgroundColor: "var(--geist-bg-100)" }}>
      {/* ---- Sidebar: mobile overlay drawer / desktop inline ---- */}
      {isMobile && historyOpen && (
        <div className="fixed inset-0 z-50 flex animate-fade-in-fast">
          <div
            className="flex-1"
            style={{ backgroundColor: "rgba(0,0,0,0.32)" }}
            onClick={() => setHistoryOpen(false)}
          />
          <aside
            className="w-[280px] shrink-0 h-full flex flex-col border-l animate-fade-in-fast"
            style={{
              backgroundColor: "var(--geist-bg-200)",
              borderColor: "var(--geist-border)",
            }}
          >
            {sidebarInner}
          </aside>
        </div>
      )}
      {!isMobile && (
        <aside
          className={cn(
            "h-full border-r shrink-0 flex flex-col transition-all duration-200",
            historyOpen ? "w-[280px]" : "w-0 border-r-0 overflow-hidden",
          )}
          style={{
            backgroundColor: "var(--geist-bg-200)",
            borderColor: "var(--geist-border)",
          }}
        >
          {sidebarInner}
        </aside>
      )}

      {/* ---- Main ---- */}
      <main className="flex-1 min-w-0 h-full flex flex-col">
        {/* Header */}
        <div
          className="h-12 px-4 flex items-center gap-2 border-b shrink-0"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] hover:bg-[var(--geist-bg-200)] text-[var(--geist-secondary)] transition-colors"
            aria-label={t("ai.toggleHistory")}
          >
            <Menu size={16} />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="h-6 w-6 rounded-full inline-flex items-center justify-center shrink-0"
              style={{ backgroundColor: "var(--geist-primary)", color: "var(--geist-bg-100)" }}
            >
              <Bot size={13} />
            </div>
            <span className="text-[13px] font-semibold truncate">{activeSession.title}</span>
          </div>
          <span className="text-[11px] text-[var(--geist-secondary)] ml-auto tracking-wide uppercase">
            MailGo Agent
          </span>
        </div>

        {/* Messages / Landing */}
        <div ref={scrollerRef} className="flex-1 overflow-y-auto">
          {showLanding ? (
            /* ---- Landing Screen ---- */
            <div className="h-full flex flex-col items-center justify-center px-4">
              <div className="max-w-[600px] w-full text-center space-y-8">
                <div className="space-y-3">
                  <div className="inline-flex mx-auto">
                    <img src="/icon.png" alt="MailGo AI" className="h-14 w-14" />
                  </div>
                  <h1 className="text-[22px] font-bold" style={{ color: "var(--geist-primary)" }}>
                    {t("ai.assistant")}
                  </h1>
                  <p className="text-[14px] leading-relaxed" style={{ color: "var(--geist-secondary)" }}>
                    {WELCOME_MESSAGE}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => void sendPrompt(s.label)}
                      className="group flex items-center gap-2.5 rounded-[12px] border px-4 py-3 text-left text-[13px] transition-all hover:shadow-sm hover:border-[var(--geist-primary)]"
                      style={{
                        borderColor: "var(--geist-border)",
                        color: "var(--geist-secondary)",
                      }}
                    >
                      <span
                        className="shrink-0 h-7 w-7 rounded-[8px] inline-flex items-center justify-center transition-colors group-hover:bg-[var(--geist-primary)] group-hover:text-white"
                        style={{ backgroundColor: "var(--geist-bg-200)", color: "var(--geist-secondary)" }}
                      >
                        {s.icon}
                      </span>
                      <span className="group-hover:text-[var(--geist-primary)] transition-colors">
                        {s.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* ---- Chat Messages ---- */
            <div className="max-w-[780px] mx-auto py-6 px-4 space-y-1">
              {activeSession.messages.map((message, idx) => {
                const isLast = idx === activeSession.messages.length - 1;
                const streaming = loading && isLast && message.role === "assistant";
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    streaming={streaming}
                  />
                );
              })}
              {/* Thinking indicator */}
              {loading &&
                activeSession.messages[activeSession.messages.length - 1]?.role === "user" && (
                  <div className="flex gap-3 py-3">
                    <div
                      className="h-8 w-8 rounded-full inline-flex items-center justify-center shrink-0"
                      style={{
                        background: "linear-gradient(135deg, var(--geist-primary), var(--geist-blue-500, #0070f3))",
                        color: "var(--geist-bg-100)",
                      }}
                    >
                      <Bot size={15} />
                    </div>
                    <div
                      className="flex items-center gap-2 rounded-[14px] px-4 py-3 text-[13px]"
                      style={{ backgroundColor: "var(--geist-bg-200)", color: "var(--geist-secondary)" }}
                    >
                      <Loader2 size={14} className="animate-spin" />
                      <span>{t("ai.thinking")}</span>
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>

        {/* ---- Input Area ---- */}
        <div className="shrink-0 px-4 pb-4 pt-2">
          <div className="max-w-[780px] mx-auto">

            {/* Input box */}
            <div
              className="rounded-[16px] border shadow-sm overflow-hidden transition-shadow focus-within:shadow-md"
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
                    void sendPrompt(input);
                  }
                }}
                rows={1}
                placeholder={t("ai.inputPlaceholder")}
                className="w-full resize-none bg-transparent outline-none text-[14px] px-4 pt-3.5 pb-0 placeholder:text-[var(--geist-disabled)] leading-relaxed focus-visible:shadow-none focus-visible:border-transparent"
                style={{ minHeight: "24px", maxHeight: "200px" }}
              />
              <div className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void openPicker()}
                    className={cn(
                      "h-7 inline-flex items-center gap-1 rounded-full border px-2.5 text-[12px] transition-all hover:border-[var(--geist-primary)]",
                      selectedIds.length > 0
                        ? "border-[var(--geist-primary)] text-[var(--geist-primary)]"
                        : "text-[var(--geist-secondary)]",
                    )}
                    style={{ borderColor: selectedIds.length > 0 ? undefined : "var(--geist-border)" }}
                  >
                    <MailSearch size={12} />
                    {selectedIds.length > 0 ? t("ai.selectedCountShort", { count: selectedIds.length }) : t("ai.selectEmails")}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  {loading ? (
                    <button
                      onClick={stopGeneration}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-full text-white transition-opacity hover:opacity-80"
                      style={{ backgroundColor: "var(--geist-red-500, #ee0000)" }}
                      aria-label={t("ai.stop")}
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      onClick={() => void sendPrompt(input)}
                      disabled={!input.trim()}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-full disabled:opacity-30 text-white transition-all hover:opacity-90"
                      style={{
                        background: input.trim()
                          ? "linear-gradient(135deg, var(--geist-primary), var(--geist-blue-500, #0070f3))"
                          : "var(--geist-bg-200)",
                        color: input.trim() ? "white" : "var(--geist-disabled)",
                      }}
                      aria-label={t("ai.send")}
                    >
                      <SendHorizontal size={15} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ---- Email Picker Dialog ---- */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 animate-fade-in-fast"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPickerOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-[640px] rounded-[16px] shadow-xl border flex flex-col max-h-[80vh]"
            style={{ borderColor: "var(--geist-border)", backgroundColor: "var(--geist-bg-100)" }}
          >
            <div
              className="flex items-center gap-2 px-4 h-12 border-b shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <MailSearch size={15} style={{ color: "var(--geist-primary)" }} />
              <span className="text-[14px] font-semibold flex-1">{t("ai.selectEmails")}</span>
              <button
                onClick={() => setPickerOpen(false)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] text-[var(--geist-secondary)] hover:bg-[var(--geist-bg-200)]"
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--geist-border)" }}>
              <input
                value={pickerQuery}
                onChange={(e) => void searchPicker(e.target.value)}
                placeholder={t("ai.searchPlaceholder")}
                className="input w-full"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {pickerLoading ? (
                <div className="flex items-center justify-center h-20 text-[13px] text-[var(--geist-secondary)]">
                  <Loader2 size={14} className="animate-spin mr-2" /> {t("common.loading")}
                </div>
              ) : pickerMessages.length === 0 ? (
                <div className="flex items-center justify-center h-20 text-[13px] text-[var(--geist-secondary)]">
                  {t("ai.noEmails")}
                </div>
              ) : (
                <ul className="divide-y" style={{ borderColor: "var(--geist-border)" }}>
                  {pickerMessages.map((m) => {
                    const checked = selectedIds.includes(m.id);
                    return (
                      <li key={m.id}>
                        <button
                          onClick={() => togglePickMessage(m.id)}
                          className={cn(
                            "w-full text-left px-4 py-3 hover:bg-[var(--geist-bg-200)] transition-colors flex items-start gap-3",
                            checked && "bg-[var(--mailgo-sidebar-active)]",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePickMessage(m.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded accent-[var(--geist-primary)] shrink-0 mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className="text-[14px] font-medium truncate flex-1"
                                style={{ color: "var(--geist-primary)" }}
                              >
                                {m.subject || t("ai.noSubject")}
                              </span>
                              <span className="text-[11px] text-[var(--geist-secondary)] shrink-0">
                                {formatDateTime(m.received_at)}
                              </span>
                            </div>
                            <p className="text-[12px] text-[var(--geist-secondary)] mt-0.5 truncate">
                              {m.from_name || m.from_address}
                            </p>
                            <p className="text-[12px] text-[var(--geist-secondary)] mt-0.5 truncate">
                              {m.snippet}
                            </p>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div
              className="flex items-center justify-between px-4 h-12 border-t shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <span className="text-[12px] text-[var(--geist-secondary)]">
                {t("ai.selectedCountShort", { count: selectedIds.length })}
              </span>
              <Button size="small" onClick={pickDone} disabled={selectedIds.length === 0}>
                {t("ai.selectedEmailsDone")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Message Bubble
   ========================================================================== */

function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isUser = message.role === "user";
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = !!message.thinking;

  if (isUser) {
    const hasEmails = message.selectedEmailIds && message.selectedEmailIds.length > 0;
    return (
      <div className="flex justify-end gap-3 py-2">
        <div className="max-w-[72%] flex flex-col items-end gap-1">
          <div
            className="rounded-[16px] rounded-br-[4px] px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap"
            style={{
              backgroundColor: "var(--geist-primary)",
              color: "var(--geist-bg-100)",
            }}
          >
            {message.content}
          </div>
          {hasEmails && (
            <div
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 h-6 text-[11px]"
              style={{ borderColor: "var(--geist-border)", backgroundColor: "var(--geist-bg-200)" }}
            >
              <MailOpen size={11} style={{ color: "var(--geist-primary)" }} />
              <span style={{ color: "var(--geist-secondary)" }}>
                {t("ai.attachedEmails", { count: message.selectedEmailIds!.length })}
              </span>
            </div>
          )}
          <span className="text-[10px] px-1" style={{ color: "var(--geist-disabled)" }}>
            {formatTime(message.createdAt, i18n.language)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 py-2">
      <div
        className="h-8 w-8 rounded-full inline-flex items-center justify-center shrink-0 mt-0.5"
        style={{
          background: "linear-gradient(135deg, var(--geist-primary), var(--geist-blue-500, #0070f3))",
          color: "var(--geist-bg-100)",
        }}
      >
        <Bot size={15} />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {/* Thinking block */}
        {hasThinking && (
          <div
            className="rounded-[10px] border overflow-hidden"
            style={{ borderColor: "var(--geist-border)", backgroundColor: "var(--geist-bg-200)" }}
          >
            <button
              onClick={() => setShowThinking((v) => !v)}
              className="w-full flex items-center gap-2 px-3 h-9 text-[13px] text-[var(--geist-secondary)] hover:bg-[var(--geist-bg-100)] transition-colors"
            >
              <ChevronRight
                size={14}
                className={cn("transition-transform", showThinking && "rotate-90")}
              />
              <span className="font-medium">{t("ai.thinkingProcess")}</span>
              <span className="text-[11px] text-[var(--geist-disabled)] ml-auto">
                {t("ai.charCount", { count: message.thinking!.length })}
              </span>
            </button>
            {showThinking && (
              <div
                className="px-3 py-2 text-[13px] whitespace-pre-wrap max-h-[280px] overflow-y-auto"
                style={{ color: "var(--geist-secondary)", borderTop: "1px solid var(--geist-border)" }}
              >
                {message.thinking}
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div
          className="text-[14px] leading-relaxed ai-markdown"
          style={{ color: "var(--geist-primary)" }}
          dangerouslySetInnerHTML={{
            __html:
              renderMarkdown(message.content) +
              (streaming ? '<span class="ai-cursor"></span>' : ''),
          }}
        />

        {/* Timestamp + stop button */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-1" style={{ color: "var(--geist-disabled)" }}>
            {message.content ? formatTime(message.createdAt, i18n.language) : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   Helpers
   ========================================================================== */

function createEmptySession(title?: string): ChatSession {
  const now = Date.now();
  return {
    id: makeID(),
    title: title || i18n.t("ai.newChat"),
    createdAt: now,
    updatedAt: now,
    messages: [createMessage("assistant", "")],
  };
}

function createMessage(role: ChatRole, content: string): ChatMessage {
  return {
    id: makeID(),
    role,
    content,
    createdAt: Date.now(),
  };
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [createEmptySession()];
    const parsed = JSON.parse(raw) as ChatSession[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [createEmptySession()];
  } catch {
    return [createEmptySession()];
  }
}

function makeID() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function titleFromPrompt(prompt: string, fallback?: string) {
  const firstLine = prompt.split("\n")[0]?.trim() || fallback || i18n.t("ai.newChat");
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

function formatTime(ts: number, locale?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(locale || i18n.language || "en", { hour: "2-digit", minute: "2-digit" });
}

/* ==========================================================================
   Markdown Renderer
   ========================================================================== */

function renderMarkdown(md: string): string {
  if (!md) return "";
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br/>");

  // Code blocks (``` ... ```)
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Headings
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // Inline formatting — process in a single backtick-aware pass so that
  // content inside `code spans` is never touched by bold/italic/strike.
  html = applyInlineFormatting(html);

  // Block-level: blockquotes, lists, tables
  const lines = html.split("\n");
  const out: string[] = [];
  let inList = false;
  let listType = "";
  let inQuote = false;

  const closeList = () => {
    if (inList) {
      out.push(`</${listType}>`);
      inList = false;
      listType = "";
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const separatorIndex = isTableRow(line) ? nextNonEmptyLineIndex(lines, i + 1) : -1;
    if (isTableRow(line) && separatorIndex >= 0 && isTableSeparator(lines[separatorIndex])) {
      closeList();
      closeQuote();
      const header = parseTableRow(line);
      const aligns = parseTableAlignments(lines[separatorIndex] || "", header.length);
      const bodyRows: string[][] = [];
      i = separatorIndex + 1;
      while (i < lines.length) {
        if (lines[i].trim() === "") {
          const nextRowIndex = nextNonEmptyLineIndex(lines, i + 1);
          if (nextRowIndex >= 0 && isTableRow(lines[nextRowIndex])) {
            i = nextRowIndex;
          } else {
            break;
          }
        }
        if (!isTableRow(lines[i])) break;
        bodyRows.push(parseTableRow(lines[i]));
        i += 1;
      }
      i--;
      out.push(renderTable(header, bodyRows, aligns));
      continue;
    }

    const bullet = line.match(/^[-*] (.+)/);
    if (bullet) {
      closeQuote();
      if (!inList || listType !== "ul") {
        if (inList) out.push(`</${listType}>`);
        out.push("<ul>");
        inList = true;
        listType = "ul";
      }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    const num = line.match(/^\d+\. (.+)/);
    if (num) {
      closeQuote();
      if (!inList || listType !== "ol") {
        if (inList) out.push(`</${listType}>`);
        out.push("<ol>");
        inList = true;
        listType = "ol";
      }
      out.push(`<li>${num[1]}</li>`);
      continue;
    }
    closeList();
    const quote = line.match(/^&gt; (.+)/);
    if (quote) {
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(quote[1]);
      continue;
    }
    closeQuote();
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    if (/^<(h[1-6]|pre|ul|ol|blockquote|li)/.test(line.trim())) {
      out.push(line);
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push(`</${listType}>`);
  if (inQuote) out.push("</blockquote>");

  return out.join("\n");
}

/**
 * applyInlineFormatting handles inline code, bold, italic, and strikithrough
 * in a single backtick-aware pass. Content inside `code spans` is never
 * touched by bold/italic/strike — this prevents the classic bug where
 *  `` `foo **bar**` `` gets its ** treated as bold markers.
 */
function applyInlineFormatting(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Inline code — handle matched backtick runs
    if (text[i] === "`") {
      let end = i + 1;
      while (end < text.length && text[end] === "`") end++;
      const fenceLen = end - i;
      // Find matching closing fence of same length
      const closeIdx = text.indexOf("`".repeat(fenceLen), end);
      if (closeIdx !== -1) {
        const code = text.slice(end, closeIdx);
        out += fenceLen > 1
          ? `<code>${code}</code>`
          : `<code>${code}</code>`;
        i = closeIdx + fenceLen;
        continue;
      }
      // No matching close — emit as literal
      out += text[i];
      i++;
      continue;
    }

    // Bold (** or __)
    if (
      (text.slice(i, i + 2) === "**" || text.slice(i, i + 2) === "__") &&
      i + 2 < text.length
    ) {
      const marker = text.slice(i, i + 2);
      const close = text.indexOf(marker, i + 2);
      if (close !== -1 && close > i + 2) {
        const inner = text.slice(i + 2, close);
        out += `<strong>${applyInlineFormatting(inner)}</strong>`;
        i = close + 2;
        continue;
      }
    }

    // Strikethrough (~~)
    if (text.slice(i, i + 2) === "~~" && i + 2 < text.length) {
      const close = text.indexOf("~~", i + 2);
      if (close !== -1 && close > i + 2) {
        out += `<del>${text.slice(i + 2, close)}</del>`;
        i = close + 2;
        continue;
      }
    }

    // Italic (* or _) — only single marker, not preceded/followed by same
    if ((text[i] === "*" || text[i] === "_") && text[i + 1] !== text[i]) {
      const marker = text[i];
      const close = text.indexOf(marker, i + 1);
      if (close !== -1 && close > i + 1 && text[close + 1] !== marker) {
        const inner = text.slice(i + 1, close);
        out += `<em>${applyInlineFormatting(inner)}</em>`;
        i = close + 1;
        continue;
      }
    }

    out += text[i];
    i++;
  }
  return out;
}

function nextNonEmptyLineIndex(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !trimmed.startsWith("<");
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableAlignments(line: string, count: number): Array<"left" | "center" | "right"> {
  const cells = parseTableRow(line);
  return Array.from({ length: count }, (_, index) => {
    const cell = cells[index]?.trim() || "";
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function renderTable(
  header: string[],
  rows: string[][],
  aligns: Array<"left" | "center" | "right">,
): string {
  const colCount = header.length;
  const alignStyle = (index: number) => ` style="text-align:${aligns[index] || "left"}"`;
  const pad = (row: string[]) =>
    Array.from({ length: colCount }, (_, index) => row[index] || "");
  return [
    "<table>",
    "<thead><tr>",
    ...pad(header).map((cell, index) => `<th${alignStyle(index)}>${cell}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...rows.map(
      (row) =>
        `<tr>${pad(row)
          .map((cell, index) => `<td${alignStyle(index)}>${cell}</td>`)
          .join("")}</tr>`,
    ),
    "</tbody></table>",
  ].join("");
}
