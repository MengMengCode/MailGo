import { CheckCircle2, Info, AlertTriangle, AlertCircle, X } from "lucide-react";
import { useToastStore, type ToastType } from "@/stores/toast.store";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const iconFor: Record<ToastType, React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
};

const colorFor: Record<ToastType, { bg: string; border: string; color: string }> = {
  info: {
    bg: "var(--geist-bg-100)",
    border: "var(--geist-border)",
    color: "var(--geist-secondary)",
  },
  success: {
    bg: "var(--geist-green-100)",
    border: "var(--geist-green-100)",
    color: "var(--geist-green-500)",
  },
  error: {
    bg: "var(--geist-red-100)",
    border: "var(--geist-red-100)",
    color: "var(--geist-red-500)",
  },
  warning: {
    bg: "var(--geist-amber-100)",
    border: "var(--geist-amber-100)",
    color: "var(--geist-amber-500)",
  },
};

export function ToastContainer() {
  const { t: tFn } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label={tFn("common.notifications")}
    >
      {toasts.map((t) => {
        const Icon = iconFor[t.type];
        const c = colorFor[t.type];
        return (
          <div
            key={t.id}
            className={cn(
              "flex items-center gap-2 pl-3 pr-2 py-2.5 rounded-geist border text-label-14 shadow-popover animate-slide-up pointer-events-auto",
            )}
            style={{
              backgroundColor: c.bg,
              borderColor: c.border,
              minWidth: 240,
              maxWidth: 360,
            }}
            role="status"
          >
            <Icon size={16} className="shrink-0" style={{ color: c.color }} />
            <span className="flex-1 truncate" style={{ color: "var(--geist-primary)" }}>
              {t.message}
            </span>
            <button
              onClick={() => remove(t.id)}
              aria-label={tFn("common.close")}
              className="h-6 w-6 flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export { useToastStore, showToast } from "@/stores/toast.store";
