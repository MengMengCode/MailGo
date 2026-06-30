import { create } from "zustand";

export type ConfirmVariant = "primary" | "error";

export interface ConfirmOptions {
  title?: string;
  /** Long-form description shown below the title. */
  description?: string;
  /** Short single-line message. Used as a fallback if description is empty. */
  message?: string;
  destructive?: boolean;
  confirmVariant?: ConfirmVariant;
  confirmText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  destructive: boolean;
  confirmVariant: ConfirmVariant;
  confirmLabel: string;
  cancelLabel: string;
  resolver: ((ok: boolean) => void) | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  isOpen: false,
  title: "",
  message: "",
  destructive: false,
  confirmVariant: "primary",
  confirmLabel: "",
  cancelLabel: "",
  resolver: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      const message = opts.description ?? opts.message ?? "";
      set({
        isOpen: true,
        title: opts.title ?? "",
        message,
        destructive: !!opts.destructive,
        confirmVariant: opts.confirmVariant ?? "primary",
        confirmLabel: opts.confirmText ?? opts.confirmLabel ?? "",
        cancelLabel: opts.cancelLabel ?? "",
        resolver: resolve,
      });
    }),
  handleConfirm: () => {
    const r = get().resolver;
    set({ isOpen: false, resolver: null });
    r?.(true);
  },
  handleCancel: () => {
    const r = get().resolver;
    set({ isOpen: false, resolver: null });
    r?.(false);
  },
}));

/** Imperative helper so callers can `await confirm({...})` without
 *  having to subscribe to the store. The promise resolves to `true`
 *  when the user confirms and `false` when they cancel. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().confirm(opts);
}
