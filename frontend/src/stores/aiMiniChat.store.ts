import { create } from "zustand";
import type { MiniChatContext } from "@/components/ai/AIMiniChat";

interface AIMiniChatState {
  open: boolean;
  context: MiniChatContext | null;
  initialPrompt: string | undefined;
  /** Bumping this key forces the component to remount (new chat session). */
  sessionId: number;
  openMiniChat: (context: MiniChatContext, initialPrompt?: string) => void;
  closeMiniChat: () => void;
}

export const useAIMiniChatStore = create<AIMiniChatState>((set) => ({
  open: false,
  context: null,
  initialPrompt: undefined,
  sessionId: 0,
  openMiniChat: (context, initialPrompt) =>
    set((s) => ({
      open: true,
      context,
      initialPrompt,
      sessionId: s.sessionId + 1,
    })),
  closeMiniChat: () => set({ open: false, context: null, initialPrompt: undefined }),
}));
