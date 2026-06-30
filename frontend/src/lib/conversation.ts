import type { Message } from "@/lib/api";

export function conversationKey(message: Message): string {
  const subject = normalizeThreadSubject(message.subject);
  if (subject.length > 2) return `subject:${message.account_id}:${subject}`;

  const threadId = message.thread_id?.trim();
  if (threadId) return `thread:${message.account_id}:${threadId}`;

  return `message:${message.id}`;
}

export function normalizeThreadSubject(subject: string | undefined | null): string {
  if (!subject) return "";
  let next = subject.trim().toLowerCase();
  let previous = "";
  while (next && next !== previous) {
    previous = next;
    next = next
      .replace(/^\s*(re|fw|fwd)\s*[:\uff1a]\s*/i, "")
      .replace(/^\s*(\u56de\u590d|\u7b54\u590d|\u8f6c\u53d1)\s*[:\uff1a]\s*/i, "")
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .trim();
  }
  return next.replace(/\s+/g, " ");
}

export function messageTime(message: Pick<Message, "received_at" | "sent_at">): number {
  const value = Date.parse(message.received_at || message.sent_at || "");
  return Number.isFinite(value) ? value : 0;
}
