import { create } from "zustand";

export type ToastType = "info" | "success" | "error" | "warning";

export interface ToastData {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastState {
  toasts: ToastData[];
  addToast: (t: Omit<ToastData, "id">) => void;
  removeToast: (id: string) => void;
  clear: () => void;
}

let pushToast: ((t: Omit<ToastData, "id">) => void) | null = null;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    const duration = t.duration ?? 3000;
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, duration);
    }
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Imperative API for non-React callers. */
export function showToast(
  message: string,
  type: ToastType = "info",
  duration?: number,
) {
  if (pushToast) pushToast({ message, type, duration });
}

// Register the imperative API at module load and keep it in sync.
pushToast = useToastStore.getState().addToast;
useToastStore.subscribe((s) => {
  pushToast = s.addToast;
});
