import { useAIMiniChatStore } from "@/stores/aiMiniChat.store";
import { AIMiniChat } from "./AIMiniChat";

/**
 * Host component that renders the AI mini chat floating window when the
 * global store says it's open. Mounted once in Layout so any part of the
 * app can trigger it via `useAIMiniChatStore().openMiniChat(...)`.
 */
export function AIMiniChatHost() {
  const open = useAIMiniChatStore((s) => s.open);
  const context = useAIMiniChatStore((s) => s.context);
  const initialPrompt = useAIMiniChatStore((s) => s.initialPrompt);
  const sessionId = useAIMiniChatStore((s) => s.sessionId);
  const closeMiniChat = useAIMiniChatStore((s) => s.closeMiniChat);

  if (!open || !context) return null;

  return (
    <AIMiniChat
      key={sessionId}
      context={context}
      initialPrompt={initialPrompt}
      onClose={closeMiniChat}
    />
  );
}
